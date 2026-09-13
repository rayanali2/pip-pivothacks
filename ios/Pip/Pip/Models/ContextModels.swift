import Foundation

// Pivot 3 context plan (POST /context/plan). Decoded with .convertFromSnakeCase like every other model.

enum ContextResultState: String, Codable {
    case feasible
    case conditional
    case conflict
    case needsReview = "needs_review"

    var label: String {
        switch self {
        case .feasible: return "Feasible"
        case .conditional: return "Conditional"
        case .conflict: return "Conflict"
        case .needsReview: return "Needs review"
        }
    }
}

enum ContextProvenance: String, Codable {
    case liveSnowflake = "live_snowflake"
    case localFallback = "local_fallback"
    case seededDemo = "seeded_demo"
    case backupRecording = "backup_recording"

    var label: String {
        switch self {
        case .liveSnowflake: return "Live Snowflake"
        case .localFallback: return "Local fallback"
        case .seededDemo: return "Seeded demo"
        case .backupRecording: return "Backup recording"
        }
    }
}

struct ContextMoney: Codable, Hashable {
    let currency: String
    let cashCents: Int
    let reserveCents: Int
    let spendableCents: Int
    let plannedTotalCents: Int
    let fits: Bool
    let overByCents: Int
    let cashAfterPlanCents: Int
    let refundAtRiskCents: Int?
}

struct ContextNextCommitment: Codable, Hashable {
    let title: String
    let startsAt: String
    let endsAt: String
    let arrivalBufferMinutes: Int
    let arriveBy: String
}

struct ContextDeadline: Codable, Hashable {
    let taskId: String
    let title: String
    let dueAt: String
    let irreversible: Bool
}

struct ContextSnapshot: Codable, Hashable {
    let scenario: String
    let requestId: String
    let revision: Int
    let clock: String
    let timezone: String
    let now: String
    let nextCommitment: ContextNextCommitment?
    let computedFreeMinutes: Int
    let statedMinutes: Int?
    let availableMinutes: Int
    let deadlines: [ContextDeadline]
    let money: ContextMoney
}

struct ContextCandidate: Codable, Hashable {
    let taskId: String
    let title: String
    let kind: String
    let label: String
    let minutes: Int
    let pathId: String?
    let completesTask: Bool
    let fits: Bool
    let rejectedBecause: String?
}

struct ContextOverrunTarget: Codable, Hashable {
    let taskId: String
    let pathId: String?
    let segmentId: String
    let label: String
}

struct ContextScenario: Codable, Hashable {
    let segmentLabel: String
    let addedMinutes: Int
    let completesAt: String
    let slackMinutes: Int
    let violations: [String]
    let fitsOnlyWithoutOverrun: Bool
    let summary: String
}

struct ContextPlan: Codable, Hashable {
    let snapshot: ContextSnapshot
    let provenance: ContextProvenance
    let resultState: ContextResultState
    let doNow: ContextCandidate?
    let overrunTarget: ContextOverrunTarget?
    let reason: String
    let warnings: [String]
    let assumptions: [String]
    let scenario: ContextScenario?
}

struct ContextPlanRequest: Encodable {
    let requestId: String
    let statedMinutes: Int?
}

struct ContextPlanResponse: Decodable {
    let source: Source
    let replayed: Bool
    let plan: ContextPlan
}

struct ContextActionRequest: Encodable {
    let requestId: String
    let planRequestId: String
    let kind: String
}

struct ContextAction: Codable, Hashable {
    let requestId: String
    let planRequestId: String
    let taskId: String?
    let kind: String
    let createdAt: String
}

struct ContextActionResponse: Decodable {
    let source: Source
    let replayed: Bool
    let action: ContextAction
}

struct ContextHistoryEntry: Codable, Hashable, Identifiable {
    let requestId: String
    let createdAt: String
    let plan: ContextPlan
    let actions: [ContextAction]

    var id: String { requestId }
}

struct ContextHistoryResponse: Decodable {
    let source: Source
    let entries: [ContextHistoryEntry]
}

enum ContextMoneyFormatting {
    static func amount(_ cents: Int, _ currency: String) -> String {
        let sign = cents < 0 ? "-" : ""
        let value = abs(cents)
        return "\(currency) \(sign)\(value / 100).\(String(format: "%02d", value % 100))"
    }
}
