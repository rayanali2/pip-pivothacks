import SwiftUI

/// Pivot 3: live context strip, "Update context" control and the context-checked do-now card.
struct ContextSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.isOffline {
                Label("Live context planning needs the Pip API. Connect under Schedule → Server.", systemImage: "wifi.slash")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                if let plan = model.contextPlan {
                    ContextStrip(plan: plan)
                    ContextDoNowCard(plan: plan)
                } else if model.isContextLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack {
                        Text("Context plan unavailable.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button("Retry") {
                            model.updateContext(model.contextPreset)
                        }
                    }
                }
                ContextPresetPicker()
            }
        }
    }
}

struct ContextPresetPicker: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Update context · free time before class")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
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
            .pickerStyle(.segmented)
            .accessibilityLabel("Update context: free time before class")
        }
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

    private var nextText: String {
        guard let next = snapshot.nextCommitment else { return "No class" }
        return "\(next.title) \(ContextTimeFormatting.wallTime(next.startsAt))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Now \(ContextTimeFormatting.wallTime(snapshot.now)) · \(nextText) · Free \(snapshot.availableMinutes) min")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Now \(ContextTimeFormatting.wallTime(snapshot.now)). Next class \(nextText). \(snapshot.availableMinutes) minutes free.")

            Text(detailLine)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(Array(plan.warnings.enumerated()), id: \.offset) { pair in
                Label(pair.element, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var detailLine: String {
        var parts = ["Demo clock (simulated, \(snapshot.timezone))"]
        if let next = snapshot.nextCommitment {
            parts.append("arrive by \(ContextTimeFormatting.wallTime(next.arriveBy))")
        }
        if let stated = snapshot.statedMinutes {
            parts.append("you said \(stated) of \(snapshot.computedFreeMinutes) min")
        }
        parts.append(plan.resultState.label)
        parts.append(plan.provenance.label)
        parts.append("rev \(snapshot.revision)")
        return parts.joined(separator: " · ")
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
            Text("Do this now")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.accentColor)

            if let doNow = plan.doNow {
                Text(doNow.label)
                    .font(.title.bold())
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Recommendation: \(doNow.label)")

                Text(Self.scopeText(doNow))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)

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
                    .accessibilityHint("Checks \(target.label) with 10 extra minutes without changing your plan")

                    if let scenario = model.contextScenario, model.contextScenarioRequestID == plan.snapshot.requestId {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(scenario.summary)
                                .font(.footnote)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Preview only · your plan is unchanged")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text("Nothing fits right now")
                    .font(.title2.bold())
            }

            Text(plan.reason)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color.accentColor.opacity(0.1))
        )
    }

    private static func scopeText(_ doNow: ContextCandidate) -> String {
        switch doNow.kind {
        case "prep": return "\(doNow.minutes) min · prepares \(doNow.title); does not complete it"
        case "first_step": return doNow.completesTask ? "\(doNow.minutes) min · finishes \(doNow.title)" : "\(doNow.minutes) min · first step of \(doNow.title), not the whole task"
        default: return "\(doNow.minutes) min · completes \(doNow.title)"
        }
    }
}
