import Foundation

/// "What if this takes 10 minutes longer?" for the do-now card. View-only: never applied,
/// saved to History or spoken.
struct OverrunPreview: Equatable {
    let itemId: String
    let headline: String
    /// do-now of the hypothetical plan
    let doNowTitle: String?
    /// the hypothetical plan picks a different do-now
    let changed: Bool
}

/// The full-screen focus timer opened by "Start now". Mirrored on the Live Activity.
struct FocusSession: Identifiable, Equatable {
    let id: String
    let item: PlanItem
    let title: String
    let action: String
    let startedAt: Date
    /// includes every extension
    var endsAt: Date
    let plannedMinutes: Int
    var extendedMinutes: Int
    /// "CHEM 110 Lab · 2:00 PM" when the plan's next item is a fixed block
    let nextLabel: String?
    let nextLocation: String?
    let moneyAtRisk: Double?
}
