import SwiftUI

/// Pivot 3: live context strip, "Update context" control and the context-checked do-now card.
struct ContextSection: View {
    @Environment(AppModel.self) private var model
    @State private var changeMessage: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.isOffline {
                UniMateStatusView(symbol: "wifi.slash", title: "Context offline", detail: "Connect in Schedule → Server. Your saved plan still works.")
            } else {
                if let plan = model.contextPlan {
                    ContextOverview(plan: plan)
                    ContextPresetPicker()
                    if let changeMessage { WhatChangedBanner(headline: changeMessage) }
                    if model.isContextLoading {
                        UniMateStatusView(symbol: "", title: "Updating…", detail: "Previous result shown below.", loading: true)
                    }
                    ContextDoNowCard(plan: plan)
                        .disabled(model.isContextLoading)
                        .opacity(model.isContextLoading ? 0.55 : 1)
                        .id(plan.snapshot.requestId)
                        .transition(.opacity)
                } else if model.isContextLoading {
                    UniMateStatusView(symbol: "", title: "Time check", detail: "Finding a fit…", loading: true)
                } else {
                    HStack {
                        Text("Context plan unavailable.")
                            .font(.subheadline)
                            .foregroundStyle(UniMateDesign.secondary)
                        Button("Retry") {
                            model.updateContext(model.contextPreset)
                        }
                    }
                }
                if model.contextPlan == nil { ContextPresetPicker() }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: model.contextPlan?.snapshot.requestId)
        .onChange(of: model.contextPlan) { old, new in
            guard let old, let new, old.snapshot.requestId != new.snapshot.requestId else { return }
            let previous = old.doNow?.label ?? "Nothing fits"
            let current = new.doNow?.label ?? "Nothing fits"
            changeMessage = previous == current
                ? "\(new.snapshot.availableMinutes) min · \(current) stays first."
                : "\(previous) → \(current) · \(new.snapshot.availableMinutes) min"
        }
    }
}

struct ContextPresetPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Available time")
                .font(.caption.weight(.semibold))
                .foregroundStyle(UniMateDesign.secondary)
            if typeSize.isAccessibilitySize {
                presetPicker.pickerStyle(.menu)
            } else {
                presetPicker.pickerStyle(.segmented)
            }
        }
    }
    private var presetPicker: some View {
        Picker(
                "Free time",
                selection: Binding(
                    get: { model.contextPreset },
                    set: { model.updateContext($0) }
                )
            ) {
                ForEach(ContextPreset.allCases) { preset in
                    Text(preset.label).tag(preset)
                }
            }
        .accessibilityLabel("Update context: free time before class")
    }

}

enum ContextTimeFormatting {
    /// Wall-clock time straight from the ISO string, so the simulated clock never shifts with the device time zone.
    static func wallTime(_ iso: String) -> String {
        let chars = Array(iso)
        guard chars.count >= 16, let h = Int(String(chars[11...12])), let m = Int(String(chars[14...15])) else {
            return iso
        }
        let h12 = h % 12 == 0 ? 12 : h % 12
        return "\(h12):\(String(format: "%02d", m)) \(h < 12 ? "AM" : "PM")"
    }
}

struct ContextStrip: View {
    let plan: ContextPlan

    private var snapshot: ContextSnapshot { plan.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ContextFacts(
                now: ContextTimeFormatting.wallTime(snapshot.now),
                next: snapshot.nextCommitment?.title ?? "No upcoming class",
                time: snapshot.nextCommitment.map { ContextTimeFormatting.wallTime($0.startsAt) },
                minutes: snapshot.availableMinutes
            )
            Text("Demo clock · \(plan.provenance.label)")
                .font(.caption).foregroundStyle(UniMateDesign.secondary)
            ForEach(Array(plan.warnings.enumerated()), id: \.offset) { pair in
                Label(pair.element, systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(UniMateDesign.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct ContextDoNowCard: View {
    @Environment(AppModel.self) private var model
    let plan: ContextPlan

    private var isStarted: Bool {
        model.contextStartedRequestID == plan.snapshot.requestId
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                PlanTag(text: plan.resultState.label, symbol: plan.doNow == nil ? "clock.badge.exclamationmark" : "checkmark.shield", tint: plan.resultState == .feasible ? UniMateDesign.accent : UniMateDesign.warning)
                Spacer()
                Image(systemName: "scope").font(.title2).foregroundStyle(UniMateDesign.accent)
            }
            if let doNow = plan.doNow {
                Text(doNow.label).font(UniMateDesign.heading)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Recommendation: \(doNow.label)")
                HStack(spacing: 8) {
                    PlanTag(text: "\(doNow.minutes) min", symbol: "timer")
                    PlanTag(text: doNow.completesTask ? "Full task" : doNow.kind == "prep" ? "Prep only" : "First step", symbol: "flag")
                }
                WindowFitView(used: doNow.minutes, available: plan.snapshot.availableMinutes, compact: true)
                Button { model.startContextNow() } label: {
                    Label(isStarted ? "Started" : "Start now", systemImage: isStarted ? "checkmark" : "play.fill")
                }
                .buttonStyle(PrimaryButtonStyle()).disabled(isStarted)
                .accessibilityLabel(isStarted ? "Started \(doNow.label)" : "Start now: \(doNow.label)")
                PlanDisclosure(title: "Why this fits", text: plan.reason, symbol: "checkmark.shield")
                if let target = plan.overrunTarget {
                    Button { model.previewOverrun() } label: {
                        HStack {
                            Label("Test +10 min", systemImage: "clock.badge.questionmark")
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }
                        .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                    }
                    .accessibilityHint("Checks \(target.label) with 10 extra minutes without changing your plan")
                    if let scenario = model.contextScenario, model.contextScenarioRequestID == plan.snapshot.requestId {
                        VStack(alignment: .leading, spacing: 12) {
                            PlanTag(text: scenario.violations.isEmpty ? "Still fits" : "Window exceeded", symbol: scenario.violations.isEmpty ? "checkmark.circle" : "exclamationmark.triangle", tint: scenario.violations.isEmpty ? UniMateDesign.positive : UniMateDesign.warning)
                            HStack {
                                Label(ContextTimeFormatting.wallTime(scenario.completesAt), systemImage: "flag.checkered")
                                Spacer()
                                Text("\(scenario.slackMinutes) min slack").monospacedDigit()
                            }.font(.caption.weight(.medium))
                            PlanDisclosure(title: "Preview details", text: scenario.summary)
                            Text("Preview only · plan unchanged").font(.caption2).foregroundStyle(UniMateDesign.secondary)
                        }
                        .padding(14).background(Color.white, in: RoundedRectangle(cornerRadius: 18))
                    }
                }
            } else {
                Text("No fit right now").font(UniMateDesign.heading)
                PlanDisclosure(title: "See why", text: plan.reason)
            }
        }
        .uniMateCard(emphasized: true)
    }
}

private struct ContextOverview: View {
    let plan: ContextPlan
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(plan.snapshot.availableMinutes)")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold)).monospacedDigit()
                Text("min free").font(.subheadline).foregroundStyle(UniMateDesign.secondary)
                Spacer()
                Image(systemName: "clock").font(.title2).foregroundStyle(UniMateDesign.accent)
            }
            if let next = plan.snapshot.nextCommitment {
                Label("\(next.title) · \(ContextTimeFormatting.wallTime(next.startsAt))", systemImage: "graduationcap")
                    .font(.subheadline.weight(.medium))
            }
            Text("Now \(ContextTimeFormatting.wallTime(plan.snapshot.now)) · demo clock")
                .font(.caption).foregroundStyle(UniMateDesign.secondary)
            if !plan.warnings.isEmpty {
                PlanDisclosure(title: "\(plan.warnings.count) risk alert\(plan.warnings.count == 1 ? "" : "s")", text: plan.warnings.joined(separator: "\n\n"), symbol: "exclamationmark.triangle")
                    .tint(UniMateDesign.warning)
            }
            Text(plan.provenance.label).font(.caption2).foregroundStyle(UniMateDesign.secondary)
        }
    }
}
