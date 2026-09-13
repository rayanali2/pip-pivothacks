import Foundation

// Every enum decodes leniently: an unexpected raw value maps to `.unknown`
// so one surprising string never breaks a whole plan.

enum Source: String, Codable, Hashable {
    case snowflake
    case fallback
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = Source(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .snowflake: return "Snowflake"
        case .fallback, .unknown: return "Local fallback"
        }
    }
}

enum CaptureSource: String, Codable, Hashable {
    case voice
    case text
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = CaptureSource(rawValue: raw) ?? .unknown
    }
}

enum TaskCategory: String, Codable, Hashable, CaseIterable {
    case classSession = "class"
    case assignment
    case errand
    case meal
    case money
    case work
    case club
    case social
    case rest
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = TaskCategory(rawValue: raw) ?? .unknown
    }

    /// All real categories (excludes `.unknown`), for pickers.
    static var known: [TaskCategory] {
        allCases.filter { $0 != .unknown }
    }

    var label: String {
        switch self {
        case .classSession: return "Class"
        case .assignment: return "Assignment"
        case .errand: return "Errand"
        case .meal: return "Meal"
        case .money: return "Money"
        case .work: return "Work"
        case .club: return "Club"
        case .social: return "Social"
        case .rest: return "Rest"
        case .unknown: return "Other"
        }
    }
}

enum TaskStatus: String, Codable, Hashable {
    case open
    case done
    case deferred
    case dropped
    case expired
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = TaskStatus(rawValue: raw) ?? .unknown
    }
}

enum ActionKind: String, Codable, Hashable {
    case startNow = "start_now"
    case done
    case deferTask = "defer"
    case drop
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = ActionKind(rawValue: raw) ?? .unknown
    }

    var pastTenseLabel: String {
        switch self {
        case .startNow: return "Started"
        case .done: return "Done"
        case .deferTask: return "Deferred"
        case .drop: return "Dropped"
        case .unknown: return "Action"
        }
    }
}

enum RuleId: String, Codable, Hashable {
    case irreversibleLoss = "irreversible_loss"
    case fixedBlockCollision = "fixed_block_collision"
    case basicNeeds = "basic_needs"
    case fitsWindow = "fits_window"
    case academicDeadline = "academic_deadline"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = RuleId(rawValue: raw) ?? .unknown
    }
}

enum Chronotype: String, Codable, Hashable, CaseIterable {
    case earlyBird = "early_bird"
    case neutral
    case nightOwl = "night_owl"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = Chronotype(rawValue: raw) ?? .unknown
    }

    static var known: [Chronotype] {
        [.earlyBird, .neutral, .nightOwl]
    }

    var label: String {
        switch self {
        case .earlyBird: return "Early bird"
        case .neutral: return "Neutral"
        case .nightOwl: return "Night owl"
        case .unknown: return "Unknown"
        }
    }
}

enum DecayCurve: String, Codable, Hashable {
    case cliff
    case linear
    case dailyReset = "daily_reset"
    case risingFloor = "rising_floor"
    case deferMultiplier = "defer_multiplier"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = DecayCurve(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .cliff: return "Cliff"
        case .linear: return "Linear"
        case .dailyReset: return "Daily reset"
        case .risingFloor: return "Rising floor"
        case .deferMultiplier: return "Defer multiplier"
        case .unknown: return "Curve"
        }
    }
}

enum PlanSection: String, Codable, Hashable {
    case doNow = "do_now"
    case next
    case today
    case canWait = "can_wait"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = PlanSection(rawValue: raw) ?? .unknown
    }
}

enum PlanItemKind: String, Codable, Hashable {
    case task
    case fixedBlock = "fixed_block"
    case guardItem = "guard"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = PlanItemKind(rawValue: raw) ?? .unknown
    }
}

enum PlanItemFlag: String, Codable, Hashable {
    case atRisk = "at_risk"
    case balanceGuard = "balance_guard"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = PlanItemFlag(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .atRisk: return "At risk"
        case .balanceGuard: return "Basic need"
        case .unknown: return "Note"
        }
    }
}

enum PlanTrigger: String, Codable, Hashable {
    case capture
    case rerank
    case seed
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try String(from: decoder)
        self = PlanTrigger(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .capture: return "Voice/text capture"
        case .rerank: return "Follow-up"
        case .seed: return "Seed"
        case .unknown: return "Plan"
        }
    }
}
