import Foundation

/// Serves the bundled MOCK_MODE fixtures (copied flat into the bundle root) when the API
/// is unreachable. Keeps a little in-memory state so captures, reruns and "Start now"
/// show up in History. Every response reports source "fallback".
@MainActor
final class OfflineService: PipService {
    let isOffline = true

    private let decoder = PipCoding.makeDecoder()
    private var historyEntries: [HistoryEntry]?
    private var weekBlocks: [TimetableBlock]?
    private var storedProfile: Profile?
    private var knownPlans: [String: Plan] = [:]
    private var knownTasks: [PipTask] = []

    enum Fixture: String {
        case health
        case captureVoice = "capture_voice"
        case rerank25 = "rerank_25"
        case timetableToday = "timetable_today"
        case timetableWeek = "timetable_week"
        case profile
        case history
        case pivotLog = "pivot_log"
        case actionStartNow = "action_start_now"
    }

    func load<T: Decodable>(_ fixture: Fixture, as type: T.Type) throws -> T {
        guard let url = Bundle.main.url(forResource: fixture.rawValue, withExtension: "json") else {
            throw PipError.missingFixture(fixture.rawValue)
        }
        let data = try Data(contentsOf: url)
        return try decoder.decode(type, from: data)
    }

    // MARK: PipService

    func health() async throws -> HealthResponse {
        var response = try load(.health, as: HealthResponse.self)
        response.source = .fallback
        return response
    }

    // Context planning is computed by the API; nothing is bundled, so offline never shows a stored answer as new.
    func contextPlan(requestID: String, statedMinutes: Int?) async throws -> ContextPlanResponse {
        throw PipError.server("Live context planning needs the Pip API.")
    }

    func contextAction(requestID: String, planRequestID: String) async throws -> ContextActionResponse {
        throw PipError.server("Live context planning needs the Pip API.")
    }

    func contextHistory() async throws -> ContextHistoryResponse {
        ContextHistoryResponse(source: .fallback, entries: [])
    }

    func captureVoice(fileURL: URL, followupPlanID: String?) async throws -> CaptureResponse {
        try? FileManager.default.removeItem(at: fileURL)
        if followupPlanID != nil {
            return try followUpCapture(transcript: "I only have 25 minutes.")
        }
        let base = try load(.captureVoice, as: CaptureResponse.self)
        return remember(capture: base, transcript: base.transcript)
    }

    func captureText(_ text: String, followupPlanID: String?) async throws -> CaptureResponse {
        if followupPlanID != nil {
            return try followUpCapture(transcript: text)
        }
        let base = try load(.captureVoice, as: CaptureResponse.self)
        return remember(capture: base, transcript: text)
    }

    func rerank(planID: String, context: RerankContextInput) async throws -> RerankResponse {
        var response = try load(.rerank25, as: RerankResponse.self)
        response.source = .fallback
        knownPlans[response.plan.planId] = response.plan
        recordPlanInHistory(response.plan, transcript: nil, diff: response.diff)
        return response
    }

    func timetableToday() async throws -> TodayTimetableResponse {
        var response = try load(.timetableToday, as: TodayTimetableResponse.self)
        response.source = .fallback
        return response
    }

    func timetable() async throws -> TimetableResponse {
        if let weekBlocks {
            return TimetableResponse(source: .fallback, studentId: Config.studentID, blocks: weekBlocks)
        }
        var response = try load(.timetableWeek, as: TimetableResponse.self)
        response.source = .fallback
        return response
    }

    func putTimetable(blocks: [TimetableBlockInput]) async throws -> TimetableResponse {
        let converted = blocks.map { input in
            TimetableBlock(
                studentId: Config.studentID,
                dayOfWeek: input.dayOfWeek,
                title: input.title,
                startsAt: input.startsAt,
                endsAt: input.endsAt,
                location: input.location
            )
        }
        weekBlocks = converted
        return TimetableResponse(source: .fallback, studentId: Config.studentID, blocks: converted)
    }

    func profile() async throws -> ProfileResponse {
        if let storedProfile {
            return ProfileResponse(source: .fallback, profile: storedProfile)
        }
        var response = try load(.profile, as: ProfileResponse.self)
        response.source = .fallback
        return response
    }

    func putProfile(_ request: PutProfileRequest) async throws -> ProfileResponse {
        let base = try await profile().profile
        let merged = Profile(
            studentId: base.studentId,
            chronotype: request.chronotype ?? base.chronotype,
            cooksOwnMeals: request.cooksOwnMeals ?? base.cooksOwnMeals,
            cashAvailable: request.cashAvailable ?? base.cashAvailable,
            budgetUntil: request.budgetUntil ?? base.budgetUntil,
            procrastinatesOn: request.procrastinatesOn ?? base.procrastinatesOn,
            updatedAt: DateFormatting.nowISO()
        )
        storedProfile = merged
        return ProfileResponse(source: .fallback, profile: merged)
    }

    func recordAction(planID: String, taskID: String?, kind: ActionKind) async throws -> ActionResponse {
        let template = try? load(.actionStartNow, as: ActionResponse.self)
        let now = DateFormatting.nowISO()
        let action = Action(
            actionId: "offline-\(UUID().uuidString.prefix(8).lowercased())",
            studentId: Config.studentID,
            planId: planID,
            taskId: taskID,
            kind: kind,
            createdAt: now
        )

        var entries = loadHistoryEntries()
        if let index = entries.firstIndex(where: { $0.planId == planID }) {
            let historyAction = HistoryAction(
                actionId: action.actionId,
                studentId: action.studentId,
                planId: action.planId,
                taskId: action.taskId,
                kind: action.kind,
                createdAt: action.createdAt,
                taskTitle: title(forTaskID: taskID)
            )
            entries[index].actions.append(historyAction)
            historyEntries = entries
        }

        var task: PipTask?
        if let templateTask = template?.task, templateTask.taskId == taskID {
            task = templateTask
        } else if let taskID {
            task = knownTasks.first(where: { $0.taskId == taskID })
        }
        return ActionResponse(source: .fallback, action: action, task: task)
    }

    func history() async throws -> HistoryResponse {
        HistoryResponse(source: .fallback, studentId: Config.studentID, entries: loadHistoryEntries())
    }

    func pivotLog() async throws -> PivotLogResponse {
        var response = try load(.pivotLog, as: PivotLogResponse.self)
        response.source = .fallback
        return response
    }

    func resetDemo() async throws -> DemoResetResponse {
        historyEntries = nil
        weekBlocks = nil
        storedProfile = nil
        knownPlans = [:]
        knownTasks = []
        return DemoResetResponse(source: .fallback, ok: true)
    }

    // MARK: Private

    private func followUpCapture(transcript: String) throws -> CaptureResponse {
        let base = try load(.captureVoice, as: CaptureResponse.self)
        let rerank = try load(.rerank25, as: RerankResponse.self)
        knownPlans[base.plan.planId] = base.plan
        knownPlans[rerank.plan.planId] = rerank.plan
        knownTasks = base.tasks
        recordPlanInHistory(rerank.plan, transcript: transcript, diff: rerank.diff)
        return CaptureResponse(
            source: .fallback,
            capture: base.capture,
            transcript: transcript,
            needsText: false,
            tasks: base.tasks,
            plan: rerank.plan,
            diff: rerank.diff,
            previousPlanId: rerank.previousPlanId
        )
    }

    private func remember(capture base: CaptureResponse, transcript: String) -> CaptureResponse {
        knownPlans[base.plan.planId] = base.plan
        knownTasks = base.tasks
        recordPlanInHistory(base.plan, transcript: transcript, diff: nil)
        return CaptureResponse(
            source: .fallback,
            capture: base.capture,
            transcript: transcript,
            needsText: false,
            tasks: base.tasks,
            plan: base.plan,
            diff: nil,
            previousPlanId: nil
        )
    }

    private func loadHistoryEntries() -> [HistoryEntry] {
        if let historyEntries {
            return historyEntries
        }
        let loaded = (try? load(.history, as: HistoryResponse.self))?.entries ?? []
        historyEntries = loaded
        return loaded
    }

    private func recordPlanInHistory(_ plan: Plan, transcript: String?, diff: PlanDiff?) {
        var entries = loadHistoryEntries()
        let now = DateFormatting.nowISO()
        if let index = entries.firstIndex(where: { $0.planId == plan.planId }) {
            var existing = entries.remove(at: index)
            existing.createdAt = now
            entries.insert(existing, at: 0)
        } else {
            let previousTitle = diff?.previousDoNowTitle
            let changed: String
            if let diff {
                if diff.doNowChanged, let previousTitle, let currentTitle = plan.doNow?.title {
                    changed = "do now: \(previousTitle) → \(currentTitle)"
                } else {
                    changed = diff.headline
                }
            } else {
                changed = "first plan"
            }
            let entry = HistoryEntry(
                planId: plan.planId,
                captureId: plan.captureId,
                createdAt: now,
                model: plan.model,
                trigger: plan.reasoning.trigger,
                transcript: transcript,
                context: plan.reasoning.context,
                doNowTaskId: plan.doNow?.taskId,
                doNowTitle: plan.doNow?.title,
                previousDoNowTitle: previousTitle,
                changed: changed,
                actions: []
            )
            entries.insert(entry, at: 0)
        }
        historyEntries = entries
    }

    private func title(forTaskID taskID: String?) -> String? {
        guard let taskID else { return nil }
        for plan in knownPlans.values {
            if let item = plan.allItems.first(where: { $0.taskId == taskID }) {
                return item.title
            }
        }
        return knownTasks.first(where: { $0.taskId == taskID })?.normalizedText
    }
}
