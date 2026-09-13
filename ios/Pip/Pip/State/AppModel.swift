import Foundation
import Observation
import SwiftUI

enum PipState: Equatable {
    case idle
    case listening
    case thinking
    case speaking

    var caption: String {
        switch self {
        case .idle: return "Hold to talk"
        case .listening: return "Listening…"
        case .thinking: return "Thinking…"
        case .speaking: return "Speaking…"
        }
    }
}

enum AppTab: Hashable {
    case home
    case today
    case schedule
    case history
}

@MainActor
@Observable
final class AppModel {
    // MARK: Pip / capture
    var pipState: PipState = .idle
    var transcript: String = ""
    var draft: String = ""
    var needsText = false
    var hasCapture = false
    var isFollowUpRecording = false
    /// Incremented to ask the Home text field to take focus.
    var textFocusRequest = 0

    // MARK: Plan
    var currentPlan: Plan?
    var previousPlan: Plan?
    var lastDiff: PlanDiff?
    var tasks: [PipTask] = []
    var highlightedItemIDs: Set<String> = []
    /// item_id of the item whose "Start now" was just recorded.
    var startNowConfirmation: String?
    var actionMessage: String?

    // MARK: Schedule / profile / history
    var todayTimetable: TodayTimetableResponse?
    var weekTimetable: [TimetableBlock] = []
    var profile: Profile?
    var history: [HistoryEntry] = []
    var pivotLog: [PivotLogEntry] = []

    // MARK: Connection
    var lastSource: Source = .fallback
    var health: HealthResponse?
    var isOffline = true
    var serverURLString: String = Config.apiBaseURLString
    var connectionStatus: String?
    var isTestingConnection = false

    // MARK: UI
    var isMuted: Bool = Config.isMuted
    var errorBanner: String?
    var selectedTab: AppTab = .home

    // `let` properties are never tracked by @Observable, so they need no @ObservationIgnored.
    private let router: ServiceRouter
    private let recorder: Recorder
    private let speaker: Speaker
    @ObservationIgnored private var highlightTask: Task<Void, Never>?
    @ObservationIgnored private var bannerTask: Task<Void, Never>?
    @ObservationIgnored private var hasBootstrapped = false

    init() {
        router = ServiceRouter()
        recorder = Recorder()
        speaker = Speaker()
        speaker.onSpeakingChanged = { [weak self] speaking in
            self?.handleSpeakingChanged(speaking)
        }
    }

    // MARK: Derived

    var isDraftEdited: Bool {
        let edited = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let original = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        return hasCapture && !edited.isEmpty && edited != original
    }

    var isBusy: Bool {
        pipState == .thinking
    }

    func task(for item: PlanItem) -> PipTask? {
        guard let taskID = item.taskId else { return nil }
        return tasks.first(where: { $0.taskId == taskID })
    }

    // MARK: Launch

    func bootstrap() async {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        await connect()
        await refreshAll()
    }

    func refreshAll() async {
        await refreshSchedule()
        await refreshProfile()
        await refreshHistory()
        await refreshPivotLog()
    }

    // MARK: Voice

    func startRecording(followUp: Bool = false) {
        guard pipState != .listening, pipState != .thinking else { return }

        switch recorder.permission {
        case .undetermined:
            Task { [weak self] in
                guard let self else { return }
                let granted = await self.recorder.requestPermission()
                if granted {
                    self.showBanner("Microphone ready. Hold the button to talk.")
                } else {
                    self.showBanner("Microphone access is off. Type your day instead.")
                    self.requestTextFocus()
                }
            }
            return
        case .denied:
            showBanner("Microphone access is off. Enable it in Settings or type instead.")
            requestTextFocus()
            return
        case .granted:
            break
        }

        speaker.stop()
        do {
            try recorder.start()
            isFollowUpRecording = followUp
            pipState = .listening
        } catch {
            pipState = .idle
            showError(error)
        }
    }

    func stopRecordingAndSend() {
        guard pipState == .listening else { return }
        let followUp = isFollowUpRecording
        isFollowUpRecording = false

        guard let fileURL = recorder.stop() else {
            pipState = .idle
            return
        }

        let followupPlanID: String? = followUp ? currentPlan?.planId : nil
        pipState = .thinking

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.captureVoice(fileURL: fileURL, followupPlanID: followupPlanID)
                }
                try? FileManager.default.removeItem(at: fileURL)
                self.handleCapture(response, isFollowUp: followupPlanID != nil)
            } catch {
                try? FileManager.default.removeItem(at: fileURL)
                self.handleFailure(error)
            }
        }
    }

    // MARK: Text

    func sendText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, pipState != .thinking else { return }
        recorder.discard()
        speaker.stop()
        pipState = .thinking

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.captureText(trimmed, followupPlanID: nil)
                }
                self.handleCapture(response, isFollowUp: false)
            } catch {
                self.handleFailure(error)
            }
        }
    }

    func submitEditedTranscript() {
        sendText(draft)
    }

    /// Rerank the current plan with a typed follow-up (context.question).
    func followUp(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let planID = currentPlan?.planId else {
            sendText(trimmed)
            return
        }
        guard pipState != .thinking else { return }
        recorder.discard()
        speaker.stop()
        pipState = .thinking

        Task { [weak self] in
            guard let self else { return }
            do {
                let context = RerankContextInput(question: trimmed)
                let response = try await self.call { service in
                    try await service.rerank(planID: planID, context: context)
                }
                self.lastSource = self.resolvedSource(response.source)
                self.applyPlan(response.plan, diff: response.diff)
            } catch {
                self.handleFailure(error)
            }
        }
    }

    /// Hold-to-talk on the follow-up bar: a voice capture with followup_plan_id.
    func startFollowUpVoice() {
        startRecording(followUp: currentPlan != nil)
    }

    // MARK: Actions

    func startNow(item: PlanItem) {
        record(kind: .startNow, item: item)
    }

    func record(kind: ActionKind, item: PlanItem) {
        guard let planID = currentPlan?.planId else {
            showError(PipError.noPlan)
            return
        }
        let taskID = item.taskId

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.recordAction(planID: planID, taskID: taskID, kind: kind)
                }
                self.lastSource = self.resolvedSource(response.source)
                if kind == .startNow {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        self.startNowConfirmation = item.itemId
                    }
                } else {
                    self.actionMessage = "\(kind.pastTenseLabel): \(item.title) · saved to History"
                }
                await self.refreshHistory()
            } catch {
                self.showError(error)
            }
        }
    }

    func toggleMute() {
        isMuted.toggle()
        Config.isMuted = isMuted
        if isMuted {
            speaker.stop()
            if pipState == .speaking {
                pipState = .idle
            }
        }
    }

    // MARK: Refresh

    func refreshSchedule() async {
        if let today = try? await call({ service in try await service.timetableToday() }) {
            todayTimetable = today
        }
        if let week = try? await call({ service in try await service.timetable() }) {
            weekTimetable = week.blocks
        }
    }

    func refreshProfile() async {
        if let response = try? await call({ service in try await service.profile() }) {
            profile = response.profile
        }
    }

    func refreshHistory() async {
        if let response = try? await call({ service in try await service.history() }) {
            history = response.entries
        }
    }

    func refreshPivotLog() async {
        if let response = try? await call({ service in try await service.pivotLog() }) {
            pivotLog = response.entries
        }
    }

    // MARK: Schedule & profile

    /// PUT /timetable with the full week. Returns true on success.
    @discardableResult
    func saveTimetable(_ blocks: [TimetableBlock]) async -> Bool {
        let previous = weekTimetable
        weekTimetable = blocks
        let inputs = blocks.map { TimetableBlockInput(block: $0) }
        do {
            let response = try await call { service in
                try await service.putTimetable(blocks: inputs)
            }
            weekTimetable = response.blocks
            if let today = try? await call({ service in try await service.timetableToday() }) {
                todayTimetable = today
            }
            return true
        } catch {
            weekTimetable = previous
            showError(error)
            return false
        }
    }

    /// PUT /profile (partial merge). Returns true on success.
    @discardableResult
    func saveProfile(_ request: PutProfileRequest) async -> Bool {
        do {
            let response = try await call { service in
                try await service.putProfile(request)
            }
            profile = response.profile
            return true
        } catch {
            showError(error)
            return false
        }
    }

    func resetDemo() async {
        do {
            _ = try await call { service in
                try await service.resetDemo()
            }
            speaker.stop()
            recorder.discard()
            highlightTask?.cancel()
            currentPlan = nil
            previousPlan = nil
            lastDiff = nil
            tasks = []
            transcript = ""
            draft = ""
            hasCapture = false
            needsText = false
            highlightedItemIDs = []
            startNowConfirmation = nil
            actionMessage = nil
            pipState = .idle
            await refreshAll()
            connectionStatus = "Demo data reset."
        } catch {
            showError(error)
        }
    }

    // MARK: Server

    func updateServerURL(_ string: String) async {
        serverURLString = string
        await testConnection()
    }

    func testConnection() async {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Config.makeURL(from: trimmed) != nil else {
            connectionStatus = "That isn't a valid http:// address."
            return
        }
        isTestingConnection = true
        Config.setAPIBaseURL(trimmed)
        router.reloadBaseURL()
        await connect()
        isTestingConnection = false
        if isOffline {
            connectionStatus = "Couldn't reach \(trimmed). Using local fallback data."
        } else {
            connectionStatus = "Connected to \(trimmed)."
            await refreshAll()
        }
    }

    // MARK: Banner

    func showBanner(_ message: String) {
        bannerTask?.cancel()
        withAnimation(.easeInOut(duration: 0.25)) {
            errorBanner = message
        }
        bannerTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, let self else { return }
            withAnimation(.easeInOut(duration: 0.25)) {
                self.errorBanner = nil
            }
        }
    }

    func dismissBanner() {
        bannerTask?.cancel()
        errorBanner = nil
    }

    // MARK: Private

    private func connect() async {
        let result = await router.connect()
        health = result
        isOffline = router.isOffline
        if router.isOffline {
            lastSource = .fallback
        } else {
            lastSource = result?.source ?? .fallback
        }
    }

    private func call<T>(_ operation: (any PipService) async throws -> T) async throws -> T {
        do {
            let result = try await router.run(operation)
            isOffline = router.isOffline
            return result
        } catch {
            isOffline = router.isOffline
            throw error
        }
    }

    private func resolvedSource(_ source: Source) -> Source {
        isOffline ? .fallback : source
    }

    private func handleCapture(_ response: CaptureResponse, isFollowUp: Bool) {
        lastSource = resolvedSource(response.source)
        hasCapture = true

        if response.needsText {
            needsText = true
            if !isFollowUp {
                transcript = response.transcript
                draft = response.transcript
            } else {
                showBanner("Pip couldn't hear that. Try typing your question.")
            }
            requestTextFocus()
            speakOrIdle("I couldn't quite hear that. Can you type it instead?")
            return
        }

        needsText = false
        tasks = response.tasks
        if !isFollowUp {
            transcript = response.transcript
            draft = response.transcript
        }
        applyPlan(response.plan, diff: response.diff)
    }

    private func applyPlan(_ plan: Plan, diff: PlanDiff?) {
        let previous = currentPlan
        var highlights = Set((diff?.moves ?? []).map { $0.itemId })
        if let diff, diff.doNowChanged, let doNowID = plan.doNow?.itemId {
            highlights.insert(doNowID)
        }

        withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) {
            previousPlan = previous
            currentPlan = plan
            lastDiff = diff
            highlightedItemIDs = highlights
            startNowConfirmation = nil
            actionMessage = nil
        }

        scheduleHighlightClear()
        speakPlan(plan, isRerun: diff != nil)

        Task { [weak self] in
            await self?.refreshHistory()
        }
    }

    private func scheduleHighlightClear() {
        highlightTask?.cancel()
        guard !highlightedItemIDs.isEmpty else { return }
        highlightTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled, let self else { return }
            withAnimation(.easeOut(duration: 0.6)) {
                self.highlightedItemIDs = []
            }
        }
    }

    private func speakPlan(_ plan: Plan, isRerun: Bool) {
        guard let doNow = plan.doNow else {
            speakOrIdle(plan.reasoning.summary)
            return
        }
        var parts: [String] = []
        if isRerun, let answer = plan.reasoning.answer, !answer.isEmpty {
            parts.append(answer)
        }
        let action = doNow.action.hasSuffix(".") ? String(doNow.action.dropLast()) : doNow.action
        parts.append("Do now: \(action).")
        parts.append(doNow.why)
        speakOrIdle(parts.joined(separator: " "))
    }

    private func speakOrIdle(_ text: String) {
        if !isMuted && speaker.speak(text) {
            pipState = .speaking
        } else {
            pipState = .idle
        }
    }

    private func handleSpeakingChanged(_ speaking: Bool) {
        if speaking {
            if pipState == .idle {
                pipState = .speaking
            }
        } else if pipState == .speaking {
            pipState = .idle
        }
    }

    private func handleFailure(_ error: Error) {
        pipState = .idle
        showError(error)
    }

    private func requestTextFocus() {
        textFocusRequest += 1
    }

    private func showError(_ error: Error) {
        showBanner(Self.message(for: error))
    }

    private static func message(for error: Error) -> String {
        if let decoding = error as? DecodingError {
            switch decoding {
            case .keyNotFound(let key, let context):
                return "Unexpected server data: missing \(key.stringValue) at \(codingPathString(context.codingPath))."
            case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
                return "Unexpected server data at \(codingPathString(context.codingPath)): \(context.debugDescription)"
            @unknown default:
                return "Unexpected server data."
            }
        }
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return error.localizedDescription
    }

    private static func codingPathString(_ path: [CodingKey]) -> String {
        let text = path.map { key -> String in
            if let index = key.intValue {
                return "[\(index)]"
            }
            return key.stringValue
        }.joined(separator: ".")
        return text.isEmpty ? "top level" : text
    }
}

// MARK: - Previews

extension AppModel {
    static func preview(withPlan: Bool = true) -> AppModel {
        let model = AppModel()
        model.todayTimetable = SampleData.todayTimetable
        if withPlan, let plan = SampleData.plan {
            model.currentPlan = plan
            model.tasks = SampleData.tasks
            model.transcript = SampleData.demoSentence
            model.draft = SampleData.demoSentence
            model.hasCapture = true
        }
        return model
    }
}
