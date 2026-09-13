import SwiftUI

/// Pivot 3: live context strip, "Update context" control and the context-checked do-now card.
struct ContextSection: View {
    @Environment(AppModel.self) private var model
    @State private var changeMessage: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.isOffline {
                PipStatusView(symbol: "wifi.slash", title: "Live context is offline", detail: "Voice and text plans still work. Connect in Schedule → Server.")
            } else {
                if let plan = model.contextPlan {
                    ContextStrip(plan: plan)
                    ContextPresetPicker()
                    if let changeMessage { WhatChangedBanner(headline: changeMessage) }
                    if model.isContextLoading {
                        PipStatusView(symbol: "", title: "Checking your new window", detail: "Showing your last pick until it’s ready", loading: true)
                    }
                    // Stays fully readable while re-checking; the disabled button and status row signal the refresh.
                    ContextDoNowCard(plan: plan)
                        .disabled(model.isContextLoading)
                        .id(plan.snapshot.requestId)
                        .transition(.opacity)
                } else if model.isContextLoading {
                    PipStatusView(symbol: "", title: "Checking your context", detail: "Finding what fits before class", loading: true)
                } else {
                    HStack {
                        Label("Context plan unavailable", systemImage: "exclamationmark.circle")
                            .font(.subheadline)
                            .foregroundStyle(PipDesign.secondary)
                        Spacer(minLength: 8)
                        Button {
                            model.updateContext(model.contextPreset)
                        } label: {
                            Text("Retry")
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .font(.subheadline.weight(.semibold))
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
                ? "With \(new.snapshot.availableMinutes) min, \(current) still comes first."
                : "With \(new.snapshot.availableMinutes) min, \(current) replaces \(previous)."
        }
    }
}

struct ContextPresetPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    title
                    Spacer(minLength: 8)
                    hint
                }
                VStack(alignment: .leading, spacing: 4) {
                    title
                    hint
                }
            }
            if typeSize.isAccessibilitySize {
                presetPicker.pickerStyle(.menu)
            } else {
                presetPicker.pickerStyle(.segmented)
            }
        }
    }

    private var title: some View {
        Label("Free time before class", systemImage: "hourglass")
            .labelStyle(PipCompactLabelStyle())
            .pipEyebrow()
    }

    private var hint: some View {
        Label("Updates your pick", systemImage: "arrow.down")
            .labelStyle(PipCompactLabelStyle())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(PipDesign.accent)
            .accessibilityHidden(true)
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
        VStack(alignment: .leading, spacing: 8) {
            ContextFacts(
                now: ContextTimeFormatting.wallTime(snapshot.now),
                next: snapshot.nextCommitment?.title ?? "No upcoming class",
                time: snapshot.nextCommitment.map { ContextTimeFormatting.wallTime($0.startsAt) },
                minutes: snapshot.availableMinutes
            )
            Label("Demo clock · \(plan.provenance.label)", systemImage: "info.circle")
                .labelStyle(PipCompactLabelStyle())
                .font(.caption2).foregroundStyle(PipDesign.secondary)
            ForEach(Array(plan.warnings.enumerated()), id: \.offset) { pair in
                Label(pair.element, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(PipDesign.warning)
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
        VStack(alignment: .leading, spacing: 12) {
            Label("Do this now", systemImage: "sparkle")
                .labelStyle(PipCompactLabelStyle())
                .pipEyebrow(PipDesign.accent)

            if let doNow = plan.doNow {
                Text(doNow.label)
                    .font(PipDesign.title)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Recommendation: \(doNow.label)")

                VStack(alignment: .leading, spacing: 6) {
                    PipFlowLayout {
                        PipPill(text: "\(doNow.minutes) min", systemImage: "timer")
                        PipPill(text: Self.scopeLabel(doNow), systemImage: Self.scopeSymbol(doNow), tint: PipDesign.secondary)
                    }
                    if let detail = Self.scopeDetail(doNow) {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(PipDesign.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)

                Text(plan.reason)
                    .font(.subheadline).foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    model.startContextNow()
                } label: {
                    Label(isStarted ? "Started" : "Start now", systemImage: isStarted ? "checkmark" : "play.fill")
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isStarted)
                .accessibilityLabel(isStarted ? "Started \(doNow.label)" : "Start now: \(doNow.label)")

                if let target = plan.overrunTarget {
                    Button {
                        model.previewOverrun()
                    } label: {
                        Label("What if it runs 10 min over?", systemImage: "plus.circle")
                            .labelStyle(PipCompactLabelStyle())
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .font(.footnote.weight(.semibold))
                    .accessibilityHint("Checks \(target.label) with 10 extra minutes without changing your plan")

                    if let scenario = model.contextScenario, model.contextScenarioRequestID == plan.snapshot.requestId {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("10 minutes longer", systemImage: "clock.badge.exclamationmark")
                                .font(.subheadline.weight(.semibold))
                            Text(scenario.summary)
                                .font(.footnote)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Preview only · your plan is unchanged")
                                .font(.caption)
                                .foregroundStyle(PipDesign.secondary)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(PipDesign.mist, in: RoundedRectangle(cornerRadius: PipDesign.radiusSmall, style: .continuous))
                    }
                }
            } else {
                Label("Nothing fits right now", systemImage: "moon.zzz")
                    .font(PipDesign.heading)
                Text(plan.reason).font(.subheadline).foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

        }
        .pipCard(emphasized: true)
    }

    private static func scopeLabel(_ doNow: ContextCandidate) -> String {
        switch doNow.kind {
        case "prep": return "Prep only"
        case "first_step": return doNow.completesTask ? "Finishes task" : "First step"
        default: return "Finishes task"
        }
    }

    private static func scopeSymbol(_ doNow: ContextCandidate) -> String {
        switch doNow.kind {
        case "prep": return "square.and.pencil"
        case "first_step": return doNow.completesTask ? "checkmark.circle" : "flag"
        default: return "checkmark.circle"
        }
    }

    /// Keeps the honest scope: what the step does for the whole task.
    private static func scopeDetail(_ doNow: ContextCandidate) -> String? {
        switch doNow.kind {
        case "prep": return "Prepares \(doNow.title); does not complete it"
        case "first_step": return doNow.completesTask ? "Finishes \(doNow.title)" : "Part of \(doNow.title), not the whole task"
        default: return doNow.label == doNow.title ? nil : "Completes \(doNow.title)"
        }
    }
}
