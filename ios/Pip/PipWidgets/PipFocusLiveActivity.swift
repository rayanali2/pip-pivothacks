import ActivityKit
import SwiftUI
import WidgetKit

/// Lock Screen and Dynamic Island UI for a focus session started from the do-now card.
struct UniMateFocusLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: UniMateFocusAttributes.self) { context in
            FocusLockScreenView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .activitySystemActionForegroundColor(FocusStyle.tint)
        } dynamicIsland: { context in
            let timeUp = FocusStyle.isTimeUp(context.state, isStale: context.isStale)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        FocusMark(size: 28)
                        Text(context.attributes.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    FocusCountdown(endsAt: context.state.endsAt, timeUp: timeUp)
                        .font(.title3.weight(.semibold))
                        .frame(maxWidth: 88, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    FocusDetailLine(attributes: context.attributes, timeUp: timeUp)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                Image(systemName: "bird.fill")
                    .foregroundStyle(FocusStyle.tint)
                    .accessibilityLabel("UniMate focus")
            } compactTrailing: {
                FocusCountdown(endsAt: context.state.endsAt, timeUp: timeUp)
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: 44)
            } minimal: {
                Image(systemName: timeUp ? "bell.fill" : "timer")
                    .foregroundStyle(FocusStyle.tint)
                    .accessibilityLabel(timeUp ? "Time is up" : "Focus timer")
            }
            .keylineTint(FocusStyle.tint)
        }
    }
}

// MARK: Lock Screen

private struct FocusLockScreenView: View {
    let attributes: UniMateFocusAttributes
    let state: UniMateFocusAttributes.ContentState
    let isStale: Bool

    var body: some View {
        let timeUp = FocusStyle.isTimeUp(state, isStale: isStale)
        HStack(alignment: .center, spacing: 14) {
            FocusMark(size: 36)

            VStack(alignment: .leading, spacing: 3) {
                Text(eyebrow)
                    .font(.caption2.weight(.semibold))
                    .tracking(1.1)
                    .foregroundStyle(.secondary)
                Text(attributes.title)
                    .font(.headline)
                    .lineLimit(1)
                FocusDetailLine(attributes: attributes, timeUp: timeUp)
            }

            Spacer(minLength: 8)

            if !timeUp, state.phase != "done" {
                FocusCountdown(endsAt: state.endsAt, timeUp: false)
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                    .frame(maxWidth: 120, alignment: .trailing)
            }
        }
        .padding(16)
    }

    private var eyebrow: String {
        if state.phase == "done" { return "DONE" }
        if state.extendedMinutes > 0 { return "FOCUS · +\(state.extendedMinutes) MIN" }
        return "FOCUS"
    }
}

// MARK: Pieces

/// "Time is up. Open UniMate" once the block is over; otherwise "Then: <next>" and the money at stake.
private struct FocusDetailLine: View {
    let attributes: UniMateFocusAttributes
    let timeUp: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if timeUp {
                Text("Time is up. Open UniMate")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(FocusStyle.tint)
            }
            if let next = attributes.nextLabel, !next.isEmpty {
                Text("Then: \(next)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let money = attributes.moneyAtRisk, money > 0 {
                Text("\(FocusStyle.dollars(money)) on the line")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
            }
        }
    }
}

/// Counts down to `endsAt`. `Text(timerInterval:)` needs a valid range, so a past end shows 0:00.
private struct FocusCountdown: View {
    let endsAt: Date
    let timeUp: Bool

    var body: some View {
        let now = Date()
        if !timeUp, endsAt > now {
            Text(timerInterval: now...endsAt, countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        } else {
            Text("0:00")
                .monospacedDigit()
                .lineLimit(1)
                .accessibilityLabel("Time is up")
        }
    }
}

private struct FocusMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(FocusStyle.tint.opacity(0.18))
            Image(systemName: "bird.fill")
                .font(.system(size: size * 0.45, weight: .semibold))
                .foregroundStyle(FocusStyle.tint)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private enum FocusStyle {
    /// Calm periwinkle. Widget targets cannot see UniMateDesign, so it is defined here.
    static let tint = Color(red: 0.43, green: 0.47, blue: 0.86)

    static func isTimeUp(_ state: UniMateFocusAttributes.ContentState, isStale: Bool) -> Bool {
        state.phase == "overtime" || isStale || state.endsAt <= Date()
    }

    /// Same output as the app's MoneyFormatting.dollars: 79 -> "$79", 21.5 -> "$21.50".
    static func dollars(_ amount: Double) -> String {
        if amount.rounded() == amount, abs(amount) < 1_000_000_000 {
            return "$\(Int(amount))"
        }
        return String(format: "$%.2f", amount)
    }
}
