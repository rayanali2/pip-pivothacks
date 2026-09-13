import SwiftUI

/// Home card shown while UniMate thinks: each step from words to plan, named by the engine that ran it.
/// Stages come from `AppModel.pipelineStages` and appear as `revealedStageCount` grows.
struct UniMateelineRevealView: View {
    @Environment(AppModel.self) private var model

    /// Placeholder rows before the server answers, in pipeline order.
    private static let pendingLabels = ["Listening back", "Finding tasks", "Weighing 5 rules", "Writing your plan"]

    var body: some View {
        let stages = model.pipelineStages
        let revealed = min(max(model.revealedStageCount, 0), stages.count)

        VStack(alignment: .leading, spacing: 16) {
            Text("PIP IS WORKING")
                .font(.caption2.weight(.bold)).tracking(1.4)
                .foregroundStyle(UniMateDesign.secondary)
                .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: 16) {
                if stages.isEmpty {
                    ForEach(Array(Self.pendingLabels.enumerated()), id: \.offset) { index, label in
                        PendingStageRow(label: label, active: index == 0)
                    }
                } else {
                    ForEach(Array(stages.enumerated()), id: \.offset) { index, stage in
                        if index < revealed {
                            RevealedStageRow(stage: stage)
                                .transition(.opacity)
                        } else {
                            PendingStageRow(label: Self.pendingLabel(for: stage), active: index == revealed)
                                .transition(.opacity)
                        }
                    }
                }
            }
        }
        .uniMateCard()
        .accessibilityElement(children: .contain)
    }

    /// Unrevealed rows keep the present-tense wording so the past-tense label isn't spoiled.
    private static func pendingLabel(for stage: UniMateelineStage) -> String {
        switch stage.id {
        case "transcribe": return pendingLabels[0]
        case "extract": return pendingLabels[1]
        case "rank": return pendingLabels[2]
        case "wording": return pendingLabels[3]
        default: return stage.label.isEmpty ? "Working" : stage.label
        }
    }
}

// MARK: - Rows

private struct PendingStageRow: View {
    let label: String
    /// The step running now: spinner and full ink. Later steps are dimmed.
    let active: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Group {
                if active {
                    ProgressView().controlSize(.small).tint(UniMateDesign.accent)
                } else {
                    Circle().strokeBorder(UniMateDesign.line, lineWidth: 1.5)
                }
            }
            .frame(width: 24, height: 24)

            Text(label)
                .font(.subheadline.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? UniMateDesign.ink : UniMateDesign.secondary)
                .opacity(active ? 1 : 0.6)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(active ? "in progress" : "waiting")")
    }
}

private struct RevealedStageRow: View {
    let stage: UniMateelineStage

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StageStatusIcon(status: stage.status)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(stage.label)
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    if let ms = stage.ms {
                        Text(StageDuration.short(ms))
                            .font(.caption.weight(.medium)).monospacedDigit()
                            .foregroundStyle(UniMateDesign.secondary)
                    }
                }
                if !stage.engine.isEmpty {
                    EnginePill(engine: stage.engine)
                }
                if !stage.detail.isEmpty {
                    Text(stage.detail)
                        .font(.footnote).foregroundStyle(UniMateDesign.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !stage.chips.isEmpty {
                    UniMateelineChipFlow(chips: stage.chips)
                        .padding(.top, 4)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    /// e.g. "Heard you, Snowflake AI_TRANSCRIBE, 1.2 seconds. 36 words."
    private var accessibilityText: String {
        var head = [stage.label, stage.engine]
        switch stage.status {
        case "fallback": head.append("fallback")
        case "skipped": head.append("skipped")
        default: break
        }
        if let ms = stage.ms { head.append(StageDuration.spoken(ms)) }
        var text = head.filter { !$0.isEmpty }.joined(separator: ", ")
        if !stage.detail.isEmpty {
            text += ". " + stage.detail.replacingOccurrences(of: " · ", with: ", ")
        }
        if !stage.chips.isEmpty {
            text += ". Found: " + stage.chips.map(\.label).joined(separator: ", ")
        }
        return text
    }
}

private struct StageStatusIcon: View {
    let status: String

    private var symbol: String {
        switch status {
        case "ok": return "checkmark"
        case "fallback": return "arrow.uturn.down"
        default: return "minus"
        }
    }

    private var tint: Color {
        switch status {
        case "ok": return UniMateDesign.positive
        case "fallback": return UniMateDesign.warning
        default: return UniMateDesign.secondary
        }
    }

    var body: some View {
        Image(systemName: symbol)
            .font(.caption.weight(.bold))
            .foregroundStyle(tint)
            .frame(width: 24, height: 24)
            .background(tint.opacity(0.12), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Small capsule naming the engine, so it's clear what did the work.
private struct EnginePill: View {
    let engine: String

    /// Only a mark for engines the server named; everything else stays plain text.
    private var symbol: String? {
        if engine.hasPrefix("Snowflake") { return "snowflake" }
        if engine.hasPrefix("Claude") { return "sparkle" }
        if engine.hasPrefix("On-device") { return "iphone" }
        return nil
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility sizes the engine name wraps instead of truncating, so the pill becomes a rounded tag.
        let wraps = typeSize.isAccessibilitySize
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if let symbol {
                Image(systemName: symbol)
            }
            Text(engine)
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: false, vertical: wraps)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(UniMateDesign.ink)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(UniMateDesign.mist, in: RoundedRectangle(cornerRadius: wraps ? 10 : 999, style: .continuous))
    }
}

private enum StageDuration {
    /// "820 ms", or "1.2 s" from a second up.
    static func short(_ ms: Int) -> String {
        ms < 1000 ? "\(ms) ms" : String(format: "%.1f s", Double(ms) / 1000)
    }

    /// "820 milliseconds", or "1.2 seconds" from a second up.
    static func spoken(_ ms: Int) -> String {
        ms < 1000 ? "\(ms) milliseconds" : String(format: "%.1f seconds", Double(ms) / 1000)
    }
}

// MARK: - Chips

/// What the extract stage pulled out, popping in one after another.
private struct UniMateelineChipFlow: View {
    let chips: [UniMateelineChip]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        UniMateFlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(Array(chips.enumerated()), id: \.offset) { index, chip in
                UniMateelineChipView(chip: chip)
                    .scaleEffect(appeared || reduceMotion ? 1 : 0.6)
                    .opacity(appeared ? 1 : 0)
                    .animation(chipAnimation(at: index), value: appeared)
            }
        }
        .onAppear { appeared = true }
    }

    /// Reduce motion: a plain fade, all at once.
    private func chipAnimation(at index: Int) -> Animation {
        if reduceMotion { return .easeOut(duration: 0.2) }
        return .spring(response: 0.38, dampingFraction: 0.62).delay(0.1 + Double(index) * 0.07)
    }
}

private struct UniMateelineChipView: View {
    let chip: UniMateelineChip

    private var symbol: String {
        switch chip.kind {
        case "task": return "checklist"
        case "fixed_block": return "lock.fill"
        case "cash": return "dollarsign.circle"
        case "time_window": return "clock"
        case "travel": return "figure.walk"
        case "question": return "questionmark.bubble"
        default: return "tag"
        }
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility sizes the label wraps instead of truncating, so the capsule becomes a rounded tag.
        let wraps = typeSize.isAccessibilitySize
        let shape = RoundedRectangle(cornerRadius: wraps ? 10 : 999, style: .continuous)
        HStack(alignment: wraps ? .firstTextBaseline : .center, spacing: 5) {
            Image(systemName: symbol)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(UniMateDesign.accent)
            Text(chip.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(UniMateDesign.ink)
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: false, vertical: wraps)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(UniMateDesign.surface, in: shape)
        .overlay { shape.strokeBorder(UniMateDesign.line) }
    }
}

// MARK: - Previews

private enum UniMateelineRevealPreview {
    /// The demo sentence's stages, `revealed` of them on screen. Without stages: still waiting on the server.
    @MainActor
    static func model(revealed: Int, withStages: Bool = true) -> AppModel {
        let model = AppModel.preview(withPlan: withStages)
        model.uniMateState = .thinking
        model.isRevealingUniMateeline = true
        model.pipelineStages = withStages ? SampleData.pipeline : []
        model.revealedStageCount = withStages ? min(revealed, SampleData.pipeline.count) : 0
        return model
    }
}

#Preview("Revealing") {
    ScrollView {
        UniMateelineRevealView()
            .padding(UniMateDesign.page)
    }
    .uniMateScreen()
    .environment(UniMateelineRevealPreview.model(revealed: 2))
}

#Preview("All stages") {
    ScrollView {
        UniMateelineRevealView()
            .padding(UniMateDesign.page)
    }
    .uniMateScreen()
    .environment(UniMateelineRevealPreview.model(revealed: 4))
}

#Preview("Waiting") {
    ScrollView {
        UniMateelineRevealView()
            .padding(UniMateDesign.page)
    }
    .uniMateScreen()
    .environment(UniMateelineRevealPreview.model(revealed: 0, withStages: false))
}
