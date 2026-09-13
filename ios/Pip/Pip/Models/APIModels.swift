import Foundation

// Mirrors api/src/types.ts. Decoded with .convertFromSnakeCase and encoded with
// .convertToSnakeCase, so every property is the camelCase form of its JSON key.
// Datetimes stay as String (IsoDateTime / IsoDate / "HH:MM"); see DateFormatting.

enum PipCoding {
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }
}

// MARK: - Rows

struct PipTask: Codable, Hashable, Identifiable {
    let taskId: String
    let studentId: String
    let captureId: String?
    let rawText: String
    let normalizedText: String
    let category: TaskCategory
    let dueAt: String?
    let moneyAtRisk: Double?
    let estMinutes: Int?
    let status: TaskStatus
    let deferCount: Int
    let createdAt: String

    var id: String { taskId }
}

struct Capture: Codable, Hashable {
    let captureId: String
    let studentId: String
    let audioStagePath: String?
    let transcript: String
    let source: CaptureSource
    let createdAt: String
}

struct TimetableBlock: Codable, Hashable, Identifiable {
    let studentId: String
    /// ISO day of week: 1 = Monday ... 7 = Sunday
    let dayOfWeek: Int
    let title: String
    /// "HH:MM"
    let startsAt: String
    /// "HH:MM"
    let endsAt: String
    let location: String?

    var id: String { "\(dayOfWeek)|\(startsAt)|\(endsAt)|\(title)" }
}

struct Profile: Codable, Hashable {
    let studentId: String
    let chronotype: Chronotype
    let cooksOwnMeals: Bool
    let cashAvailable: Double
    let budgetUntil: String?
    let procrastinatesOn: TaskCategory?
    let updatedAt: String
}

struct Action: Codable, Hashable {
    let actionId: String
    let studentId: String
    let planId: String
    let taskId: String?
    let kind: ActionKind
    let createdAt: String
}

struct PivotLogEntry: Codable, Hashable, Identifiable {
    let entryId: String
    let pivotNumber: Int
    let revealed: String
    let assumptionChanged: String
    let response: String
    let cut: String
    let sentence: String?
    let createdAt: String

    var id: String { entryId }
}

// MARK: - Plan

struct RuleEvidence: Codable, Hashable {
    let rule: RuleId
    let label: String
    let fired: Bool
    let detail: String
}

struct CurvePoint: Codable, Hashable, Identifiable {
    /// hours of postponement from plan time
    let hours: Double
    /// relative cost of postponing, 0...1
    let cost: Double

    var id: Double { hours }
}

struct PlanItem: Codable, Hashable, Identifiable {
    let itemId: String
    let kind: PlanItemKind
    let taskId: String?
    let title: String
    let action: String
    let category: TaskCategory?
    let why: String
    let startsAt: String?
    let endsAt: String?
    let estMinutes: Int?
    let dueAt: String?
    let moneyAtRisk: Double?
    let location: String?
    let flag: PlanItemFlag?
    let rulesFired: [RuleId]
    let evidence: [RuleEvidence]
    let curve: [CurvePoint]
    let curveKind: DecayCurve?

    var id: String { itemId }
}

struct FreeWindow: Codable, Hashable {
    let startsAt: String
    let endsAt: String
    let minutes: Int
    let nextBlockTitle: String?
    let nextBlockStartsAt: String?
    let label: String
}

struct PlanContext: Codable, Hashable {
    let availableMinutes: Int?
    let cashAvailable: Double?
    let question: String?
}

struct PlanWarning: Codable, Hashable {
    let taskId: String?
    let text: String
}

struct PreRankEntry: Codable, Hashable {
    let taskId: String
    let score: Double
    let rulesFired: [RuleId]
    let firstStepMinutes: Int
    let fits: Bool
}

struct PlanReasoning: Codable, Hashable {
    let summary: String
    /// the scenario clock the plan was computed for
    let now: String
    let freeWindow: FreeWindow?
    let effectiveMinutes: Int
    let context: PlanContext
    let cashAvailable: Double
    let budgetUntil: String?
    let daysUntilBudget: Int?
    let dailyBudget: Double?
    let warnings: [PlanWarning]
    let balanceGuard: [String]
    let answer: String?
    let preRank: [PreRankEntry]
    let trigger: PlanTrigger
    let previousPlanId: String?
}

struct Plan: Codable, Hashable, Identifiable {
    let planId: String
    let studentId: String
    let captureId: String?
    let createdAt: String
    let model: String
    let doNow: PlanItem?
    let next: PlanItem?
    let today: [PlanItem]
    let canWait: [PlanItem]
    let reasoning: PlanReasoning

    var id: String { planId }

    /// Every item in the plan, in display order.
    var allItems: [PlanItem] {
        var items: [PlanItem] = []
        if let doNow { items.append(doNow) }
        if let next { items.append(next) }
        items.append(contentsOf: today)
        items.append(contentsOf: canWait)
        return items
    }
}

struct PlanMove: Codable, Hashable {
    let itemId: String
    let title: String
    let from: PlanSection?
    let to: PlanSection?
    let fromIndex: Int?
    let toIndex: Int?
    let reason: String
}

struct PlanDiff: Codable, Hashable {
    let headline: String
    let doNowChanged: Bool
    let previousDoNowTitle: String?
    let moves: [PlanMove]
}

struct HistoryAction: Codable, Hashable {
    let actionId: String
    let studentId: String
    let planId: String
    let taskId: String?
    let kind: ActionKind
    let createdAt: String
    let taskTitle: String?
}

struct HistoryEntry: Codable, Hashable, Identifiable {
    let planId: String
    let captureId: String?
    var createdAt: String
    let model: String
    let trigger: PlanTrigger
    let transcript: String?
    let context: PlanContext?
    let doNowTaskId: String?
    let doNowTitle: String?
    let previousDoNowTitle: String?
    let changed: String
    var actions: [HistoryAction]

    var id: String { planId }
}

struct CortexStatus: Codable, Hashable {
    let transcribe: String?
    let complete: String?
    let completeModel: String?
    let embed: String?
    let verifiedAt: String?
    let errors: [String]
}

struct SnowflakeStatus: Codable, Hashable {
    let configured: Bool
    let connected: Bool
    let error: String?
    let lastWarmPingAt: String?
}

struct ClaudeStatus: Codable, Hashable {
    let configured: Bool
    let model: String?
}

// MARK: - Pipeline

/// Something the extract stage pulled out of the words.
struct PipelineChip: Codable, Hashable {
    /// "task" | "fixed_block" | "cash" | "time_window" | "travel" | "question"
    let kind: String
    let label: String
}

/// One step from words to plan, named by the engine that actually ran it.
struct PipelineStage: Codable, Hashable, Identifiable {
    /// "transcribe" | "extract" | "rank" | "wording"
    let id: String
    let label: String
    let engine: String
    let detail: String
    /// "ok" | "fallback" | "skipped"
    let status: String
    let ms: Int?
    /// empty except on the extract stage
    let chips: [PipelineChip]

    enum CodingKeys: String, CodingKey {
        case id
        case label
        case engine
        case detail
        case status
        case ms
        case chips
    }
}

extension PipelineStage {
    // Lenient: the pipeline is explanation only, so a surprising stage never breaks a plan.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? container.decode(String.self, forKey: .id)) ?? "stage"
        label = (try? container.decode(String.self, forKey: .label)) ?? ""
        engine = (try? container.decode(String.self, forKey: .engine)) ?? ""
        detail = (try? container.decode(String.self, forKey: .detail)) ?? ""
        status = (try? container.decode(String.self, forKey: .status)) ?? "ok"
        ms = (try? container.decodeIfPresent(Double.self, forKey: .ms)).map { Int($0.rounded()) }
        chips = (try? container.decodeIfPresent([PipelineChip].self, forKey: .chips)) ?? []
    }
}

// MARK: - HTTP responses

struct ErrorResponse: Codable {
    let source: Source?
    let error: String
}

struct HealthResponse: Codable, Hashable {
    var source: Source
    let ok: Bool
    /// "live" | "mock"
    let mode: String
    let now: String
    let snowflake: SnowflakeStatus
    let cortex: CortexStatus
    /// absent on servers without Claude support
    var claude: ClaudeStatus?
}

struct CaptureResponse: Codable, Hashable {
    var source: Source
    let capture: Capture
    let transcript: String
    let needsText: Bool
    let tasks: [PipTask]
    let plan: Plan
    let diff: PlanDiff?
    let previousPlanId: String?
    /// absent in older servers and fixtures
    var pipeline: [PipelineStage]?
}

struct RerankResponse: Codable, Hashable {
    var source: Source
    let plan: Plan
    let previousPlanId: String
    let diff: PlanDiff
    /// absent in older servers and fixtures
    var pipeline: [PipelineStage]?
}

struct TodayTimetableResponse: Codable, Hashable {
    var source: Source
    let studentId: String
    let now: String
    let dayOfWeek: Int
    let blocks: [TimetableBlock]
    let freeWindows: [FreeWindow]
    let nextFreeWindow: FreeWindow?
}

struct TimetableResponse: Codable, Hashable {
    var source: Source
    let studentId: String
    let blocks: [TimetableBlock]
}

struct ProfileResponse: Codable, Hashable {
    var source: Source
    let profile: Profile
}

struct ActionResponse: Codable, Hashable {
    var source: Source
    let action: Action
    let task: PipTask?
}

struct HistoryResponse: Codable, Hashable {
    var source: Source
    let studentId: String
    var entries: [HistoryEntry]
}

struct PivotLogResponse: Codable, Hashable {
    var source: Source
    let entries: [PivotLogEntry]
}

struct DemoResetResponse: Codable, Hashable {
    var source: Source
    let ok: Bool
}

// MARK: - HTTP requests

struct CaptureTextRequest: Encodable {
    let studentId: String
    let text: String
    /// omitted from JSON when nil
    let followupPlanId: String?
}

/// nil fields are omitted from the JSON body; the API carries the previous plan's values forward.
struct RerankContextInput: Encodable, Hashable {
    var availableMinutes: Int?
    var cashAvailable: Double?
    var question: String?

    init(availableMinutes: Int? = nil, cashAvailable: Double? = nil, question: String? = nil) {
        self.availableMinutes = availableMinutes
        self.cashAvailable = cashAvailable
        self.question = question
    }
}

struct RerankRequest: Encodable {
    let studentId: String
    let planId: String
    let context: RerankContextInput
    /// true = compute the plan and diff without saving anything; omitted from JSON when nil
    let preview: Bool?
}

/// A timetable block without student_id (PutTimetableRequest.blocks element).
struct TimetableBlockInput: Encodable, Hashable {
    let dayOfWeek: Int
    let title: String
    let startsAt: String
    let endsAt: String
    let location: String?

    enum CodingKeys: String, CodingKey {
        case dayOfWeek
        case title
        case startsAt
        case endsAt
        case location
    }

    init(dayOfWeek: Int, title: String, startsAt: String, endsAt: String, location: String?) {
        self.dayOfWeek = dayOfWeek
        self.title = title
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.location = location
    }

    init(block: TimetableBlock) {
        self.init(
            dayOfWeek: block.dayOfWeek,
            title: block.title,
            startsAt: block.startsAt,
            endsAt: block.endsAt,
            location: block.location
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(dayOfWeek, forKey: .dayOfWeek)
        try container.encode(title, forKey: .title)
        try container.encode(startsAt, forKey: .startsAt)
        try container.encode(endsAt, forKey: .endsAt)
        if let location {
            try container.encode(location, forKey: .location)
        } else {
            try container.encodeNil(forKey: .location)
        }
    }
}

struct PutTimetableRequest: Encodable {
    let studentId: String
    let blocks: [TimetableBlockInput]
}

/// Partial merge: nil fields are omitted from the JSON body.
struct PutProfileRequest: Encodable, Hashable {
    var studentId: String = Config.studentID
    var chronotype: Chronotype?
    var cooksOwnMeals: Bool?
    var cashAvailable: Double?
    var budgetUntil: String?
    var procrastinatesOn: TaskCategory?
}

struct ActionRequest: Encodable {
    let studentId: String
    let planId: String
    let taskId: String?
    let kind: ActionKind

    enum CodingKeys: String, CodingKey {
        case studentId
        case planId
        case taskId
        case kind
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(studentId, forKey: .studentId)
        try container.encode(planId, forKey: .planId)
        if let taskId {
            try container.encode(taskId, forKey: .taskId)
        } else {
            try container.encodeNil(forKey: .taskId)
        }
        try container.encode(kind, forKey: .kind)
    }
}

struct DemoResetRequest: Encodable {
    let studentId: String
}
