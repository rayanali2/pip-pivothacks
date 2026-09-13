import Foundation
import Observation
import SwiftUI
import UIKit

enum UniMateState: Equatable {
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

/// "Update context" presets. nil minutes = the full window the server computes from the timetable and demo clock.
enum ContextPreset: String, CaseIterable, Identifiable, Hashable {
    case full
    case fortyEight
    case twentyFive

    var id: String { rawValue }

    var minutes: Int? {
        switch self {
        case .full: return nil
        case .fortyEight: return 48
        case .twentyFive: return 25
        }
    }

    var label: String {
        switch self {
        case .full: return "Full window"
        case .fortyEight: return "48 min"
        case .twentyFive: return "25 min"
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
    // MARK: UniMate / capture
    var uniMateState: UniMateState = .idle
    var transcript: String = ""
    var draft: String = ""
    var needsText = false
    var hasCapture = false
    var isFollowUpRecording = false
    /// Incremented to ask the Home text field to take focus.
    var textFocusRequest = 0
    /// +1 per spoken word, so the penguin can move while UniMate talks.
    var speechPulse = 0

    // MARK: Plan
    var currentPlan: Plan?
    var previousPlan: Plan?
    var lastDiff: PlanDiff?
    var tasks: [UniMateTask] = []
    var highlightedItemIDs: Set<String> = []
    /// item_id of the item whose "Start now" was just recorded.
    var startNowConfirmation: String?
    var actionMessage: String?
    /// Real time when `currentPlan` was applied; anchors the scenario clock.
    var planReceivedAt = Date()
    /// Timeline free-time control for the current plan.
    var availableMinutesPreset: ContextPreset = .full
    /// "10 minutes longer" answer for the do-now card. View-only; cleared whenever a plan is applied.
    var overrunPreview: OverrunPreview?
    var isOverrunPreviewLoading = false

    // MARK: UniMateeline
    /// Stages of the last capture or rerank: from the server, or truthful stand-ins when it sent none.
    var pipelineStages: [UniMateelineStage] = []
    /// How many of `pipelineStages` are on screen (0...pipelineStages.count).
    var revealedStageCount = 0
    /// True from a Home capture's start until its stages are revealed and the plan is applied.
    var isRevealingUniMateeline = false

    // MARK: Focus
    /// Non-nil while the focus session is presented full screen.
    var focusSession: FocusSession?

    // MARK: Context (Pivot 3)
    var contextPlan: ContextPlan?
    var contextPreset: ContextPreset = .full
    var contextHistory: [ContextHistoryEntry] = []
    var isContextLoading = false
    /// snapshot request id whose "Start now" was recorded
    var contextStartedRequestID: String?
    /// hypothetical "10 minutes longer" result; never applied to the accepted plan
    var contextScenario: ContextScenario?
    var contextScenarioRequestID: String?
    /// Only responses for the latest context revision may update the screen or speak.
    @ObservationIgnored private var contextRevision = 0

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

    /// How long a voice capture waits for on-device speech before sending the audio alone.
    static let onDeviceTranscriptTimeout: TimeInterval = 5
    private static let stageRevealDelay: UInt64 = 450_000_000
    private static let revealSettleDelay: UInt64 = 500_000_000

    // `let` properties are never tracked by @Observable, so they need no @ObservationIgnored.
    private let router: ServiceRouter
    private let recorder: Recorder
    private let speaker: Speaker
    @ObservationIgnored private var highlightTask: Task<Void, Never>?
    @ObservationIgnored private var bannerTask: Task<Void, Never>?
    @ObservationIgnored private var revealTask: Task<Void, Never>?
    @ObservationIgnored private var hasBootstrapped = false
    /// Only the latest plan request (capture, follow-up, rerank) may reveal, apply or speak its answer.
    @ObservationIgnored private var planRevision = 0
    /// Only the latest overrun preview may land, and only while its plan is still current.
    @ObservationIgnored private var overrunPreviewRevision = 0

    init() {
        router = ServiceRouter()
        recorder = Recorder()
        speaker = Speaker()
        speaker.onSpeakingChanged = { [weak self] speaking in
            self?.handleSpeakingChanged(speaking)
        }
        speaker.onWord = { [weak self] in
            guard let self else { return }
            self.speechPulse += 1
        }
    }

    // MARK: Derived

    var isDraftEdited: Bool {
        let edited = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let original = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        return hasCapture && !edited.isEmpty && edited != original
    }

    var isBusy: Bool {
        uniMateState == .thinking
    }

    func task(for item: PlanItem) -> UniMateTask? {
        guard let taskID = item.taskId else { return nil }
        return tasks.first(where: { $0.taskId == taskID })
    }

    /// The plan's scenario clock, advanced by the real time since the plan arrived.
    /// Returns `date` itself when there is no plan.
    func scenarioNow(at date: Date) -> Date {
        guard let plan = currentPlan, let planNow = DateFormatting.parse(plan.reasoning.now) else {
            return date
        }
        return planNow.addingTimeInterval(date.timeIntervalSince(planReceivedAt))
    }

    // MARK: Launch

    func bootstrap() async {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        // A Live Activity left over from an earlier launch has no session to finish it.
        if focusSession == nil { FocusLiveActivity.endOrphans() }
        requestSpeechAuthorizationIfMicrophoneReady()
        await connect()
        await refreshAll()
        updateContext(contextPreset)
    }

    func refreshAll() async {
        await refreshSchedule()
        await refreshProfile()
        await refreshHistory()
        await refreshPivotLog()
        await refreshContextHistory()
    }

    // MARK: Context (Pivot 3)

    /// Re-runs prioritization for the chosen free time. No restart, rebuild or re-recording.
    func updateContext(_ preset: ContextPreset) {
        guard Config.isDemoMode else { contextPlan = nil; return }
        contextPreset = preset
        contextRevision += 1
        let revision = contextRevision
        guard !isOffline else {
            contextPlan = nil
            isContextLoading = false
            return
        }
        let requestID = "ctx-\(UUID().uuidString)"
        isContextLoading = true

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.contextPlan(requestID: requestID, statedMinutes: preset.minutes)
                }
                // A late answer for an older context never replaces a newer plan or its speech.
                guard revision == self.contextRevision else { return }
                self.isContextLoading = false
                withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) {
                    self.contextPlan = response.plan
                    self.contextStartedRequestID = nil
                    self.contextScenario = nil
                    self.contextScenarioRequestID = nil
                }
                self.speakContext(response.plan)
                await self.refreshContextHistory()
            } catch {
                guard revision == self.contextRevision else { return }
                self.isContextLoading = false
                // Never keep an older answer on screen as if it had just been computed.
                self.contextPlan = nil
                self.showError(error)
            }
        }
    }

    func startContextNow() {
        guard let plan = contextPlan, plan.doNow != nil else { return }
        let planRequestID = plan.snapshot.requestId
        let requestID = "act-\(UUID().uuidString)"

        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.call { service in
                    try await service.contextAction(requestID: requestID, planRequestID: planRequestID)
                }
                withAnimation(.easeInOut(duration: 0.25)) {
                    self.contextStartedRequestID = planRequestID
                }
                await self.refreshContextHistory()
            } catch {
                self.showError(error)
            }
        }
    }

    /// Recomputes from the same frozen snapshot with one named segment 10 minutes longer. View-only.
    func previewOverrun() {
        guard let plan = contextPlan, let target = plan.overrunTarget else { return }
        let planRequestID = plan.snapshot.requestId
        let overrun = ContextOverrunInput(taskId: target.taskId, pathId: target.pathId, segmentId: target.segmentId, minutes: 10)

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.contextPreview(planRequestID: planRequestID, overrun: overrun)
                }
                guard self.contextPlan?.snapshot.requestId == planRequestID else { return }
                withAnimation(.easeInOut(duration: 0.25)) {
                    self.contextScenario = response.plan.scenario
                    self.contextScenarioRequestID = planRequestID
                }
            } catch {
                self.showError(error)
            }
        }
    }

    func refreshContextHistory() async {
        guard Config.isDemoMode else { contextHistory = []; return }
        guard !isOffline else { return }
        if let response = try? await call({ service in try await service.contextHistory() }) {
            contextHistory = response.entries
        }
    }

    private func speakContext(_ plan: ContextPlan) {
        // Never talk over (or record into) a capture in progress or its pipeline reveal.
        guard uniMateState != .listening, uniMateState != .thinking, !isRevealingUniMateeline else { return }
        speaker.stop()
        guard let doNow = plan.doNow else {
            speakOrIdle(plan.reason)
            return
        }
        speakOrIdle("Do now: \(doNow.label). \(plan.reason)")
    }

    // MARK: Voice

    func startRecording(followUp: Bool = false) {
        guard uniMateState != .listening, uniMateState != .thinking else { return }

        switch recorder.permission {
        case .undetermined:
            Task { [weak self] in
                guard let self else { return }
                let granted = await self.recorder.requestPermission()
                if granted {
                    self.showBanner("Microphone ready. Hold the button to talk.")
                    // Asked right after the microphone, never in the middle of a recording.
                    _ = await SpeechTranscriber.requestAuthorization()
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
            uniMateState = .listening
        } catch {
            uniMateState = .idle
            showError(error)
        }
    }

    func stopRecordingAndSend() {
        guard uniMateState == .listening else { return }
        let followUp = isFollowUpRecording
        isFollowUpRecording = false

        guard let fileURL = recorder.stop() else {
            uniMateState = .idle
            return
        }

        let followupPlanID: String? = followUp ? currentPlan?.planId : nil
        let isFollowUpCapture = followupPlanID != nil
        uniMateState = .thinking
        let revision = beginPlanRequest(revealing: !isFollowUpCapture)

        Task { [weak self] in
            guard let self else { return }
            // On-device words ride along with the audio; if they don't come, the server still has the audio.
            let clientTranscript = await SpeechTranscriber.transcribe(
                fileURL: fileURL,
                timeout: AppModel.onDeviceTranscriptTimeout
            )
            guard revision == self.planRevision else {
                try? FileManager.default.removeItem(at: fileURL)
                return
            }
            do {
                let response = try await self.call { service in
                    try await service.captureVoice(
                        fileURL: fileURL,
                        followupPlanID: followupPlanID,
                        clientTranscript: clientTranscript
                    )
                }
                try? FileManager.default.removeItem(at: fileURL)
                self.handleCapture(response, isFollowUp: isFollowUpCapture, typed: false, revision: revision)
            } catch {
                try? FileManager.default.removeItem(at: fileURL)
                self.handleFailure(error, revision: revision)
            }
        }
    }

    // MARK: Text

    func sendText(_ text: String, onAccepted: (() -> Void)? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, uniMateState != .thinking else { return }
        recorder.discard()
        speaker.stop()
        uniMateState = .thinking
        let revision = beginPlanRequest(revealing: true)

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.captureText(trimmed, followupPlanID: nil)
                }
                guard revision == self.planRevision else { return }
                self.handleCapture(response, isFollowUp: false, typed: true, revision: revision)
                if !response.needsText { onAccepted?() }
            } catch {
                self.handleFailure(error, revision: revision)
            }
        }
    }

    func submitEditedTranscript() {
        sendText(draft)
    }

    /// Extract newly mentioned tasks and constraints, then rerank the current plan.
    func followUp(text: String, onAccepted: (() -> Void)? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let planID = currentPlan?.planId else {
            sendText(trimmed, onAccepted: onAccepted)
            return
        }
        guard uniMateState != .thinking else { return }
        recorder.discard()
        speaker.stop()
        uniMateState = .thinking
        let revision = beginPlanRequest(revealing: false)
        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.captureText(trimmed, followupPlanID: planID)
                }
                guard revision == self.planRevision else { return }
                self.handleCapture(response, isFollowUp: true, typed: true, revision: revision)
                if !response.needsText { onAccepted?() }
            } catch {
                self.handleFailure(error, revision: revision)
            }
        }
    }

    /// Hold-to-talk on the follow-up bar: a voice capture with followup_plan_id.
    func startFollowUpVoice() {
        startRecording(followUp: currentPlan != nil)
    }

    // MARK: Timeline

    /// Reruns the current plan for the chosen free time, applied like a follow-up.
    /// With no plan yet, updates the context plan instead.
    func setAvailableMinutes(_ preset: ContextPreset) {
        guard let plan = currentPlan else {
            availableMinutesPreset = preset
            updateContext(preset)
            return
        }
        guard uniMateState != .thinking, uniMateState != .listening else { return }
        availableMinutesPreset = preset
        let minutes = preset.minutes ?? fullWindowMinutes(for: plan)
        rerankCurrentPlan(planID: plan.planId, context: RerankContextInput(availableMinutes: minutes))
    }

    /// "What if this takes 10 minutes longer?" for the plan's do-now: the same rerank with 10 fewer
    /// minutes, computed as a preview. Never touches the plan, history, highlights or speech.
    func previewPlanOverrun(item: PlanItem) {
        guard let plan = currentPlan else {
            showError(UniMateError.noPlan)
            return
        }
        overrunPreviewRevision += 1
        let revision = overrunPreviewRevision
        let planID = plan.planId
        let context = RerankContextInput(availableMinutes: max(0, plan.reasoning.effectiveMinutes - 10))
        isOverrunPreviewLoading = true

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.rerank(planID: planID, context: context, preview: true)
                }
                guard revision == self.overrunPreviewRevision, self.currentPlan?.planId == planID else { return }
                self.isOverrunPreviewLoading = false
                withAnimation(.easeInOut(duration: 0.25)) {
                    self.overrunPreview = OverrunPreview(
                        itemId: item.itemId,
                        headline: response.diff.headline,
                        doNowTitle: response.plan.doNow?.title,
                        changed: response.diff.doNowChanged
                    )
                }
            } catch {
                guard revision == self.overrunPreviewRevision else { return }
                self.isOverrunPreviewLoading = false
                self.showError(error)
            }
        }
    }

    // MARK: Actions

    /// Records start_now and opens the focus session with its Live Activity.
    func startNow(item: PlanItem) {
        record(kind: .startNow, item: item)
        openFocus(for: item)
    }

    func record(kind: ActionKind, item: PlanItem) {
        guard let planID = currentPlan?.planId else {
            showError(UniMateError.noPlan)
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
            if uniMateState == .speaking {
                uniMateState = .idle
            }
        }
    }

    // MARK: Focus

    /// endsAt = max(now, endsAt) + minutes.
    func extendFocus(minutes: Int) {
        guard var session = focusSession, minutes > 0 else { return }
        session.endsAt = max(Date(), session.endsAt).addingTimeInterval(TimeInterval(minutes * 60))
        session.extendedMinutes += minutes
        focusSession = session
        FocusLiveActivity.update(endsAt: session.endsAt, phase: "running", extendedMinutes: session.extendedMinutes)
    }

    /// done: records done, then reruns the plan for the minutes left so the next do-now is applied and spoken.
    /// Not done: closes the session and records nothing.
    func finishFocus(done: Bool) {
        guard let session = focusSession else { return }
        FocusLiveActivity.end(phase: done ? "done" : focusPhase(session))
        focusSession = nil
        // Lets Start now reopen the timer after it was closed.
        startNowConfirmation = nil
        guard done, let plan = currentPlan else { return }

        let planID = plan.planId
        let taskID = session.item.taskId
        let elapsedMinutes = max(0, Int(Date().timeIntervalSince(session.startedAt) / 60))
        let remainingMinutes = max(0, plan.reasoning.effectiveMinutes - elapsedMinutes)

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.recordAction(planID: planID, taskID: taskID, kind: .done)
                }
                self.lastSource = self.resolvedSource(response.source)
            } catch {
                self.showError(error)
                return
            }
            // A newer plan or a capture in progress owns the screen; don't replace it.
            guard self.currentPlan?.planId == planID,
                  self.uniMateState != .thinking,
                  self.uniMateState != .listening
            else {
                await self.refreshHistory()
                return
            }
            self.rerankCurrentPlan(planID: planID, context: RerankContextInput(availableMinutes: remainingMinutes))
        }
    }

    func focusStuck() {
        guard let session = focusSession else { return }
        FocusLiveActivity.end(phase: focusPhase(session))
        focusSession = nil
        followUp(text: "I'm stuck on \(session.title). What should I do instead?")
    }

    /// Demo helper: the timer runs out in 3 seconds.
    func skipFocusToEnd() {
        guard Config.isDemoMode else { return }
        guard var session = focusSession else { return }
        session.endsAt = Date().addingTimeInterval(3)
        focusSession = session
        FocusLiveActivity.update(endsAt: session.endsAt, phase: "running", extendedMinutes: session.extendedMinutes)
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
        guard Config.isDemoMode else { pivotLog = []; return }
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
        guard Config.isDemoMode else { return }
        do {
            _ = try await call { service in
                try await service.resetDemo()
            }
            speaker.stop()
            recorder.discard()
            highlightTask?.cancel()
            planRevision += 1
            revealTask?.cancel()
            revealTask = nil
            overrunPreviewRevision += 1
            FocusLiveActivity.end(phase: "done")
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
            pipelineStages = []
            revealedStageCount = 0
            isRevealingUniMateeline = false
            focusSession = nil
            overrunPreview = nil
            isOverrunPreviewLoading = false
            availableMinutesPreset = .full
            uniMateState = .idle
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
            connectionStatus = Config.isDemoMode
                ? "Couldn't reach \(trimmed). Developer demo data is active."
                : "Couldn't reach \(trimmed). Reconnect to create or update plans."
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

    private func call<T>(_ operation: (any UniMateService) async throws -> T) async throws -> T {
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

    /// Speech permission is only asked for once the microphone is allowed, and never blocks recording.
    private func requestSpeechAuthorizationIfMicrophoneReady() {
        guard recorder.permission == .granted else { return }
        Task {
            _ = await SpeechTranscriber.requestAuthorization()
        }
    }

    /// Every plan request starts here: an in-flight reveal is cancelled and older answers become stale.
    private func beginPlanRequest(revealing: Bool) -> Int {
        planRevision += 1
        revealTask?.cancel()
        revealTask = nil
        if revealing {
            pipelineStages = []
            revealedStageCount = 0
        }
        isRevealingUniMateeline = revealing
        return planRevision
    }

    /// Reruns `planID` with `context` and applies the answer right away (diff banner, highlights, speech).
    private func rerankCurrentPlan(planID: String, context: RerankContextInput) {
        recorder.discard()
        speaker.stop()
        uniMateState = .thinking
        let revision = beginPlanRequest(revealing: false)

        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.call { service in
                    try await service.rerank(planID: planID, context: context, preview: false)
                }
                guard revision == self.planRevision else { return }
                self.lastSource = self.resolvedSource(response.source)
                self.showStages(response.pipeline ?? self.fallbackStages(
                    transcript: context.question,
                    typed: true,
                    extractedTasks: nil,
                    plan: response.plan,
                    source: response.source
                ))
                self.applyPlan(response.plan, diff: response.diff)
            } catch {
                self.handleFailure(error, revision: revision)
            }
        }
    }

    private func handleCapture(_ response: CaptureResponse, isFollowUp: Bool, typed: Bool, revision: Int) {
        // A late answer for an older request never replaces a newer plan or its speech.
        guard revision == planRevision else { return }
        lastSource = resolvedSource(response.source)
        hasCapture = true

        if response.needsText {
            pipelineStages = response.pipeline ?? []
            endReveal()
            needsText = true
            if !isFollowUp {
                transcript = response.transcript
                draft = response.transcript
            } else {
                showBanner("UniMate couldn't hear that. Try typing your question.")
            }
            requestTextFocus()
            speakOrIdle("I couldn't quite hear that. Can you type it instead?")
            return
        }

        needsText = false
        if !isFollowUp {
            transcript = response.transcript
            draft = response.transcript
        }
        let stages = response.pipeline ?? fallbackStages(
            transcript: response.transcript,
            typed: typed,
            extractedTasks: isFollowUp ? nil : response.tasks,
            plan: response.plan,
            source: response.source
        )
        if isFollowUp {
            tasks = response.tasks
            showStages(stages)
            applyPlan(response.plan, diff: response.diff)
        } else {
            revealThenApply(stages, revision: revision, tasks: response.tasks, plan: response.plan, diff: response.diff)
        }
    }

    /// Shows the stages one at a time, then applies the plan. A cancelled or stale reveal applies nothing.
    private func revealThenApply(_ stages: [UniMateelineStage], revision: Int, tasks newTasks: [UniMateTask], plan: Plan, diff: PlanDiff?) {
        revealTask?.cancel()
        pipelineStages = stages
        revealedStageCount = 0
        isRevealingUniMateeline = true
        let reduceMotion = UIAccessibility.isReduceMotionEnabled

        revealTask = Task { [weak self] in
            guard let self else { return }
            if reduceMotion {
                self.revealedStageCount = stages.count
            } else {
                for index in stages.indices {
                    if index > 0 {
                        try? await Task.sleep(nanoseconds: AppModel.stageRevealDelay)
                    }
                    guard !Task.isCancelled, revision == self.planRevision else { return }
                    withAnimation(.easeOut(duration: 0.3)) {
                        self.revealedStageCount = index + 1
                    }
                }
                try? await Task.sleep(nanoseconds: AppModel.stageRevealDelay)
            }
            guard !Task.isCancelled, revision == self.planRevision else { return }
            self.tasks = newTasks
            self.applyPlan(plan, diff: diff)

            try? await Task.sleep(nanoseconds: AppModel.revealSettleDelay)
            guard !Task.isCancelled, revision == self.planRevision else { return }
            withAnimation(reduceMotion ? nil : Animation.easeOut(duration: 0.3)) {
                self.isRevealingUniMateeline = false
            }
        }
    }

    /// Follow-ups and reranks skip the reveal but keep their stages.
    private func showStages(_ stages: [UniMateelineStage]) {
        revealTask?.cancel()
        revealTask = nil
        pipelineStages = stages
        revealedStageCount = stages.count
        isRevealingUniMateeline = false
    }

    private func endReveal() {
        revealTask?.cancel()
        revealTask = nil
        revealedStageCount = pipelineStages.count
        isRevealingUniMateeline = false
    }

    /// Stand-ins when the server sent no pipeline. Offline they name the fixtures; from a live
    /// server they name only the server, because the app can't know which engine ran.
    private func fallbackStages(transcript: String?, typed: Bool, extractedTasks: [UniMateTask]?, plan: Plan, source: Source) -> [UniMateelineStage] {
        let offline = isOffline
        return UniMateelineFallback.stages(
            transcript: transcript,
            typed: typed,
            extractedTasks: extractedTasks,
            plan: plan,
            engine: offline ? UniMateelineFallback.offlineEngine : UniMateelineFallback.serverEngine,
            status: !offline && source == .snowflake ? "ok" : "fallback"
        )
    }

    /// "Full window" is sent as a number: a missing value would carry an earlier override forward.
    private func fullWindowMinutes(for plan: Plan) -> Int? {
        if let minutes = plan.reasoning.freeWindow?.minutes {
            return minutes
        }
        // No known window: the API's maximum caps nothing, so it still replaces an override.
        return plan.reasoning.context.availableMinutes == nil ? nil : 1440
    }

    /// The timeline preset a plan's context matches, or nil when none does exactly.
    private static func preset(matching plan: Plan) -> ContextPreset? {
        guard let minutes = plan.reasoning.context.availableMinutes else { return .full }
        if let preset = ContextPreset.allCases.first(where: { $0.minutes == minutes }) {
            return preset
        }
        if let window = plan.reasoning.freeWindow?.minutes, minutes >= window {
            return .full
        }
        return nil
    }

    private func applyPlan(_ plan: Plan, diff: PlanDiff?) {
        let previous = currentPlan
        var highlights = Set((diff?.moves ?? []).map { $0.itemId })
        if let diff, diff.doNowChanged, let doNowID = plan.doNow?.itemId {
            highlights.insert(doNowID)
        }
        // Any preview still running was asked about the old plan.
        overrunPreviewRevision += 1

        withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) {
            previousPlan = previous
            currentPlan = plan
            lastDiff = diff
            highlightedItemIDs = highlights
            startNowConfirmation = nil
            actionMessage = nil
            overrunPreview = nil
        }
        planReceivedAt = Date()
        isOverrunPreviewLoading = false
        if let preset = Self.preset(matching: plan) {
            availableMinutesPreset = preset
        }

        scheduleHighlightClear()
        speakPlan(plan, isRerun: diff != nil)

        Task { [weak self] in
            await self?.refreshHistory()
        }
    }

    private func openFocus(for item: PlanItem) {
        guard let plan = currentPlan else { return }
        let planned = Self.plannedMinutes(for: item)
        let startedAt = Date()

        var nextLabel: String?
        var nextLocation: String?
        if let next = plan.next, next.kind == .fixedBlock {
            if let time = DateFormatting.time(next.startsAt) {
                nextLabel = "\(next.title) · \(time)"
            } else {
                nextLabel = next.title
            }
            nextLocation = next.location
        }

        let session = FocusSession(
            id: "focus-\(UUID().uuidString)",
            item: item,
            title: item.title,
            action: item.action,
            startedAt: startedAt,
            endsAt: startedAt.addingTimeInterval(TimeInterval(planned * 60)),
            plannedMinutes: planned,
            extendedMinutes: 0,
            nextLabel: nextLabel,
            nextLocation: nextLocation,
            moneyAtRisk: item.moneyAtRisk
        )
        focusSession = session
        FocusLiveActivity.start(
            title: session.title,
            endsAt: session.endsAt,
            nextLabel: session.nextLabel,
            moneyAtRisk: session.moneyAtRisk
        )
    }

    /// The item's planned slot, else its estimate, else 15 min; always 1...180.
    private static func plannedMinutes(for item: PlanItem) -> Int {
        var minutes = 15
        if let start = DateFormatting.parse(item.startsAt),
           let end = DateFormatting.parse(item.endsAt),
           end > start {
            minutes = Int((end.timeIntervalSince(start) / 60).rounded())
        } else if let estimate = item.estMinutes, estimate > 0 {
            minutes = estimate
        }
        return min(180, max(1, minutes))
    }

    private func focusPhase(_ session: FocusSession) -> String {
        Date() > session.endsAt ? "overtime" : "running"
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
        parts.append("Here's your next step. \(action).")
        parts.append(doNow.why)
        speakOrIdle(parts.joined(separator: " "))
    }

    private func speakOrIdle(_ text: String) {
        if !isMuted && speaker.speak(text) {
            uniMateState = .speaking
        } else {
            uniMateState = .idle
        }
    }

    private func handleSpeakingChanged(_ speaking: Bool) {
        if speaking {
            if uniMateState == .idle {
                uniMateState = .speaking
            }
        } else if uniMateState == .speaking {
            uniMateState = .idle
        }
    }

    private func handleFailure(_ error: Error, revision: Int) {
        guard revision == planRevision else { return }
        endReveal()
        uniMateState = .idle
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
            model.planReceivedAt = Date()
            model.pipelineStages = SampleData.pipeline
            model.revealedStageCount = SampleData.pipeline.count
        }
        return model
    }
}
