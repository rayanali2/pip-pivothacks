import ActivityKit
import SwiftUI
import UIKit

/// Full-screen focus timer opened by "Start now". Presented while `model.focusSession` is non-nil;
/// every way out goes through the model so the Live Activity ends with it.
struct FocusSessionView: View {
    let session: FocusSession
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var isTimeUp = false
    @State private var liveActivitiesEnabled = false

    /// The model's copy wins: `session` is stale after an extension or "Skip to end".
    private var liveSession: FocusSession {
        if let live = model.focusSession, live.id == session.id {
            return live
        }
        return session
    }

    var body: some View {
        let current = liveSession
        VStack(spacing: 0) {
            topBar
            ScrollView {
                VStack(spacing: PipDesign.gap) {
                    PenguinView(state: model.pipState == .speaking ? .speaking : .idle, size: 120, ready: isTimeUp)
                    heading(current)
                    FocusTimerRing(
                        startedAt: current.startedAt,
                        endsAt: current.endsAt,
                        timeUp: isTimeUp,
                        plannedMinutes: current.plannedMinutes,
                        extendedMinutes: current.extendedMinutes
                    )
                    contextRows(current)
                    if isTimeUp {
                        timeUpCard(current)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    } else {
                        runningControls(current)
                            .transition(.opacity)
                    }
                }
                .padding(.horizontal, PipDesign.page)
                .padding(.top, 4)
                .padding(.bottom, 28)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: isTimeUp)
            }
        }
        .pipScreen()
        .sensoryFeedback(.success, trigger: isTimeUp) { oldValue, newValue in
            !oldValue && newValue
        }
        // An extension moves endsAt, which restarts the watch and puts the timer back to running.
        .task(id: current.endsAt) {
            await watchEnd(of: current)
        }
        // Back from the Lock Screen: flip now if the end passed while the app was suspended.
        .onChange(of: scenePhase) { _, phase in
            let latest = liveSession
            guard phase == .active, latest.endsAt <= Date() else { return }
            markTimeUp(latest)
        }
        .onAppear {
            liveActivitiesEnabled = ActivityAuthorizationInfo().areActivitiesEnabled
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }

    // MARK: Sections

    private var topBar: some View {
        HStack {
            Text("FOCUS")
                .font(.caption2.weight(.bold)).tracking(1.4)
                .foregroundStyle(PipDesign.secondary)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Button {
                model.finishFocus(done: false)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(PipDesign.ink)
                    .frame(width: 44, height: 44)
                    .background(Color.white, in: Circle())
                    .overlay { Circle().strokeBorder(PipDesign.line) }
            }
            .accessibilityLabel("Close focus")
            .accessibilityHint("Stops the timer without marking the task done")
        }
        .padding(.horizontal, PipDesign.page)
        .padding(.top, 8)
    }

    private func heading(_ current: FocusSession) -> some View {
        VStack(spacing: 6) {
            Text(current.title)
                .font(PipDesign.heading)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text(current.action)
                .font(.subheadline)
                .foregroundStyle(PipDesign.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func contextRows(_ current: FocusSession) -> some View {
        let next: String? = current.nextLabel.flatMap { label -> String? in label.isEmpty ? nil : label }
        let location: String? = current.nextLocation.flatMap { place -> String? in place.isEmpty ? nil : place }
        let money: Double? = current.moneyAtRisk.flatMap { amount -> Double? in amount > 0 ? amount : nil }

        if next != nil || money != nil {
            VStack(alignment: .leading, spacing: 14) {
                if let next {
                    contextRow(symbol: "arrow.turn.down.right", tint: PipDesign.accent, title: "Then: \(next)", detail: location)
                }
                if let money {
                    contextRow(symbol: "dollarsign.circle", tint: PipDesign.warning, title: "\(MoneyFormatting.dollars(money)) on the line", detail: nil)
                }
            }
            .pipCard()
        }
        if liveActivitiesEnabled {
            Label("Also on your Lock Screen", systemImage: "lock.iphone")
                .font(.caption)
                .foregroundStyle(PipDesign.secondary)
        }
    }

    private func contextRow(symbol: String, tint: Color, title: String, detail: String?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(PipDesign.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func runningControls(_ current: FocusSession) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                extendButton
                Button {
                    model.finishFocus(done: true)
                } label: {
                    Label("Done early", systemImage: "checkmark")
                }
                .buttonStyle(FocusSecondaryButtonStyle())
                .accessibilityHint("Marks \(current.title) done and picks your next step")
            }
            Button("Skip to end (demo)") {
                model.skipFocusToEnd()
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(PipDesign.secondary)
            .frame(minHeight: 44)
            .accessibilityHint("Makes the timer run out in 3 seconds")
        }
    }

    private func timeUpCard(_ current: FocusSession) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Time is up", systemImage: "bell")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PipDesign.accent)
                .accessibilityAddTraits(.isHeader)
            Text("Finished? Pip will pick your next step.")
                .font(.subheadline)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                model.finishFocus(done: true)
            } label: {
                Label("Done: what next?", systemImage: "checkmark")
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityHint("Marks \(current.title) done and picks your next step")
            HStack(spacing: 12) {
                extendButton
                Button {
                    model.focusStuck()
                } label: {
                    Label("I’m stuck", systemImage: "questionmark.bubble")
                }
                .buttonStyle(FocusSecondaryButtonStyle())
                .disabled(model.isBusy)
                .accessibilityHint("Closes the timer and asks Pip what to do instead")
            }
        }
        .pipCard(emphasized: true)
    }

    private var extendButton: some View {
        Button {
            model.extendFocus(minutes: 10)
        } label: {
            Label("+10 min", systemImage: "timer")
        }
        .buttonStyle(FocusSecondaryButtonStyle())
        .accessibilityLabel("Add 10 minutes")
    }

    // MARK: Timer

    /// Flips to "Time is up" at `endsAt`, once per end time.
    @MainActor
    private func watchEnd(of current: FocusSession) async {
        let remaining = current.endsAt.timeIntervalSinceNow
        if remaining > 0 {
            isTimeUp = false
            // Continuous clock: keeps counting while the phone is locked and asleep.
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled else { return }
        }
        markTimeUp(current)
    }

    /// Shows "Time is up" and moves the Live Activity to overtime, once per end time.
    @MainActor
    private func markTimeUp(_ current: FocusSession) {
        // Closed or replaced meanwhile: nothing left to mark.
        guard model.focusSession?.id == current.id, !isTimeUp else { return }
        isTimeUp = true
        // The Lock Screen switches to "Time is up" now instead of at its next redraw.
        FocusLiveActivity.update(endsAt: current.endsAt, phase: "overtime", extendedMinutes: current.extendedMinutes)
    }
}

/// Ring over startedAt...endsAt with the time left in the middle. Ticks once a second.
private struct FocusTimerRing: View {
    let startedAt: Date
    let endsAt: Date
    let timeUp: Bool
    let plannedMinutes: Int
    let extendedMinutes: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let diameter: CGFloat = 248
    private let lineWidth: CGFloat = 14

    /// "35 min planned · +10 min"
    private var planText: String {
        extendedMinutes > 0
            ? "\(plannedMinutes) min planned · +\(extendedMinutes) min"
            : "\(plannedMinutes) min planned"
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = timeUp ? 0 : Self.remainingSeconds(until: endsAt, at: context.date)
            let fraction: CGFloat = timeUp ? 1 : Self.elapsedFraction(from: startedAt, to: endsAt, at: context.date)

            ZStack {
                Circle()
                    .stroke(PipDesign.line, lineWidth: lineWidth)
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(PipDesign.accent, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(reduceMotion ? nil : .linear(duration: 1), value: fraction)
                VStack(spacing: 6) {
                    Text(Self.clock(seconds))
                        .font(.system(size: 60, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    Text(planText)
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(PipDesign.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
                .padding(.horizontal, lineWidth + 20)
            }
            .frame(width: diameter, height: diameter)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(timeUp ? "Time is up" : Self.spoken(seconds))
            .accessibilityValue(planText)
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private static func remainingSeconds(until endsAt: Date, at date: Date) -> Int {
        max(0, Int(endsAt.timeIntervalSince(date).rounded(.up)))
    }

    private static func elapsedFraction(from startedAt: Date, to endsAt: Date, at date: Date) -> CGFloat {
        let total = endsAt.timeIntervalSince(startedAt)
        guard total > 0 else { return 1 }
        let elapsed = date.timeIntervalSince(startedAt)
        return CGFloat(min(1, max(0, elapsed / total)))
    }

    /// 2100 -> "35:00"
    private static func clock(_ seconds: Int) -> String {
        String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    /// 2100 -> "35 minutes 0 seconds left"
    private static func spoken(_ seconds: Int) -> String {
        let minutes = seconds / 60
        let rest = seconds % 60
        let minuteWord = minutes == 1 ? "minute" : "minutes"
        let secondWord = rest == 1 ? "second" : "seconds"
        return "\(minutes) \(minuteWord) \(rest) \(secondWord) left"
    }
}

/// White, hairline-bordered companion to PrimaryButtonStyle.
private struct FocusSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        FocusSecondaryButtonBody(configuration: configuration)
    }

    private struct FocusSecondaryButtonBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PipDesign.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(PipDesign.line)
                }
                .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.45)
        }
    }
}

// MARK: - Previews

@MainActor
private enum FocusPreviewSupport {
    /// A preview model whose live focus session is `session`, so the view reads it back.
    static func model(with session: FocusSession) -> AppModel {
        let model = AppModel.preview()
        model.focusSession = session
        return model
    }

    /// The sample session with its timer about to run out.
    static func endingSoon() -> FocusSession? {
        guard var session = SampleData.focusSession else { return nil }
        session.endsAt = Date().addingTimeInterval(3)
        return session
    }
}

#Preview("Focus") {
    if let session = SampleData.focusSession {
        FocusSessionView(session: session)
            .environment(FocusPreviewSupport.model(with: session))
    } else {
        Text("No sample plan")
    }
}

#Preview("Focus · time is up") {
    if let session = FocusPreviewSupport.endingSoon() {
        FocusSessionView(session: session)
            .environment(FocusPreviewSupport.model(with: session))
    } else {
        Text("No sample plan")
    }
}
