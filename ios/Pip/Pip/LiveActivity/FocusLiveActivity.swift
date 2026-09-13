import ActivityKit
import Foundation

/// Starts, updates and ends the focus-session Live Activity (Lock Screen + Dynamic Island).
/// Every call is a no-op when Live Activities are turned off, and failures are swallowed:
/// the in-app focus timer works the same without it.
@MainActor
enum FocusLiveActivity {
    /// The activity this launch started. Older ones (for example from a previous launch) are
    /// still reachable through `Activity<UniMateFocusAttributes>.activities`.
    private static var current: Activity<UniMateFocusAttributes>?

    /// Overtime and done activities are marked stale this long after the block was due to end.
    /// Running ones go stale exactly at the end (see `content(for:)`).
    private static let staleAfter: TimeInterval = 30 * 60

    static func start(title: String, endsAt: Date, nextLabel: String?, moneyAtRisk: Double?) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // End whatever is still running first, so only one focus activity is ever on screen.
        endAll(phase: "done")

        let attributes = UniMateFocusAttributes(title: title, nextLabel: nextLabel, moneyAtRisk: moneyAtRisk)
        let state = UniMateFocusAttributes.ContentState(endsAt: endsAt, phase: "running", extendedMinutes: 0)
        do {
            current = try Activity<UniMateFocusAttributes>.request(
                attributes: attributes,
                content: content(for: state),
                pushType: nil
            )
        } catch {
            log("start failed: \(error)")
        }
    }

    static func update(endsAt: Date, phase: String, extendedMinutes: Int) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, let activity = current else { return }
        let state = UniMateFocusAttributes.ContentState(endsAt: endsAt, phase: phase, extendedMinutes: extendedMinutes)
        let newContent = content(for: state)
        Task {
            await activity.update(newContent)
        }
    }

    static func end(phase: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            current = nil
            return
        }
        endAll(phase: phase)
    }

    /// Ends focus activities left over from an earlier launch (app terminated, crashed or re-run
    /// from Xcode). Focus sessions are not persisted, so nothing in the app could finish them.
    /// Call once at launch, before any focus session starts.
    static func endOrphans() {
        guard current == nil else { return }
        endAll(phase: "done")
    }

    // MARK: Private

    private static func endAll(phase: String) {
        var activities = Activity<UniMateFocusAttributes>.activities
        if let current, !activities.contains(where: { $0.id == current.id }) {
            activities.append(current)
        }
        current = nil

        for activity in activities {
            let last = activity.content.state
            let state = UniMateFocusAttributes.ContentState(
                endsAt: last.endsAt,
                phase: phase,
                extendedMinutes: last.extendedMinutes
            )
            let finalContent = content(for: state)
            Task {
                await activity.end(finalContent, dismissalPolicy: .immediate)
            }
        }
    }

    /// A running activity goes stale exactly at `endsAt`, so the system redraws it as time up
    /// (the widget treats `isStale` as time up) even while the app is suspended and cannot push
    /// the overtime update. Extending sends a new `endsAt`, which moves the stale date forward.
    private static func content(for state: UniMateFocusAttributes.ContentState) -> ActivityContent<UniMateFocusAttributes.ContentState> {
        let staleDate = state.phase == "running" ? state.endsAt : state.endsAt.addingTimeInterval(staleAfter)
        return ActivityContent(state: state, staleDate: staleDate)
    }

    private static func log(_ message: String) {
        #if DEBUG
        print("FocusLiveActivity: \(message)")
        #endif
    }
}
