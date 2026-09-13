import SwiftUI

/// Pivot 3: live context strip, "Update context" control and the context-checked do-now card.
struct ContextSection: View {
    @Environment(AppModel.self) private var model
    @State private var changeMessage: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.isOffline {
                PipStatusView(symbol: "wifi.slash", title: "Live context is offline", detail: "Your voice and text plan still works. Connect under Schedule → Server to check time before class.")
            } else {
                if let plan = model.contextPlan {
                    ContextStrip(plan: plan)
                    ContextPresetPicker()
                    if let changeMessage { WhatChangedBanner(headline: changeMessage) }
                    if model.isContextLoading {
                        PipStatusView(symbol: "", title: "Checking your new window", detail: "The recommendation below is from your previous check.", loading: true)
                    }
                    ContextDoNowCard(plan: plan)
                        .disabled(model.isContextLoading)
                        .opacity(model.isContextLoading ? 0.55 : 1)
                        .id(plan.snapshot.requestId)
                        .transition(.opacity)
                } else if model.isContextLoading {
                    PipStatusView(symbol: "", title: "Checking your context", detail: "Finding what fits before class…", loading: true)
                } else {
                    HStack {
                        Text("Context plan unavailable.")
                            .font(.subheadline)
                            .foregroundStyle(PipDesign.secondary)
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
                ? "Checked again with \(new.snapshot.availableMinutes) minutes. \(current) still comes first."
                : "With \(new.snapshot.availableMinutes) minutes, \(current) replaces \(previous)."
        }
    }
}

struct ContextPresetPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Update context · free time before class")
                .font(.caption.weight(.semibold))
                .foregroundStyle(PipDesign.secondary)
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
                .font(.caption).foregroundStyle(PipDesign.secondary)
            ForEach(Array(plan.warnings.enumerated()), id: \.offset) { pair in
                Label(pair.element, systemImage: "exclamationmark.triangle")
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
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.accentColor)

            if let doNow = plan.doNow {
                Text(doNow.label)
                    .font(.system(.title, design: .rounded, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Recommendation: \(doNow.label)")

                Text(Self.scopeText(doNow))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(PipDesign.secondary)

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
                    Button("What if this takes 10 minutes longer?") {
                        model.previewOverrun()
                    }
                    .font(.footnote.weight(.medium))
                    .frame(minHeight: 44)
                    .accessibilityHint("Checks \(target.label) with 10 extra minutes without changing your plan")

                    if let scenario = model.contextScenario, model.contextScenarioRequestID == plan.snapshot.requestId {
                        VStack(alignment: .leading, spacing: 4) {
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
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 14))
                        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(PipDesign.accent.opacity(0.3)) }
                    }
                }
            } else {
                Text("Nothing fits right now").font(PipDesign.heading)
                Text(plan.reason).font(.subheadline).foregroundStyle(PipDesign.secondary)
            }

        }
        .pipCard(emphasized: true)
    }

    private static func scopeText(_ doNow: ContextCandidate) -> String {
        switch doNow.kind {
        case "prep": return "\(doNow.minutes) min · prepares \(doNow.title); does not complete it"
        case "first_step": return doNow.completesTask ? "\(doNow.minutes) min · finishes \(doNow.title)" : "\(doNow.minutes) min · first step of \(doNow.title), not the whole task"
        default: return "\(doNow.minutes) min · completes \(doNow.title)"
        }
    }
}
