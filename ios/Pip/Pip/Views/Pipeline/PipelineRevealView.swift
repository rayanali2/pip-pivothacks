import SwiftUI

/// Home card shown while Pip thinks: each step from words to plan, named by the engine that ran it.
/// Stages come from `AppModel.pipelineStages` and appear as `revealedStageCount` grows.
struct PipelineRevealView: View {
    @Environment(AppModel.self) private var model

    /// Placeholder rows before the server answers, in pipeline order.
    private static let pendingLabels = ["Listening back", "Finding tasks", "Weighing 5 rules", "Writing your plan"]

    var body: some View {
        let stages = model.pipelineStages
        let revealed = min(max(model.revealedStageCount, 0), stages.count)

        VStack(alignment: .leading, spacing: 16) {
            Text("PIP IS WORKING")
                .font(.caption2.weight(.bold)).tracking(1.4)
                .foregroundStyle(PipDesign.secondary)
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
        .pipCard()
        .accessibilityElement(children: .contain)
    }

    /// Unrevealed rows keep the present-tense wording so the past-tense label isn't spoiled.
    private static func pendingLabel(for stage: PipelineStage) -> String {
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
                    ProgressView().controlSize(.small).tint(PipDesign.accent)
                } else {
                    Circle().strokeBorder(PipDesign.line, lineWidth: 1.5)
                }
            }
            .frame(width: 24, height: 24)

            Text(label)
                .font(.subheadline.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? PipDesign.ink : PipDesign.secondary)
                .opacity(active ? 1 : 0.6)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(active ? "in progress" : "waiting")")
    }
}

private struct RevealedStageRow: View {
    let stage: PipelineStage

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
                            .foregroundStyle(PipDesign.secondary)
                    }
                }
                if !stage.engine.isEmpty {
                    EnginePill(engine: stage.engine)
                }
                if !stage.detail.isEmpty {
                    Text(stage.detail)
                        .font(.footnote).foregroundStyle(PipDesign.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !stage.chips.isEmpty {
                    PipelineChipFlow(chips: stage.chips)
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
        case "ok": return PipDesign.positive
        case "fallback": return PipDesign.warning
        default: return PipDesign.secondary
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
        .foregroundStyle(PipDesign.ink)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(PipDesign.mist, in: RoundedRectangle(cornerRadius: wraps ? 10 : 999, style: .continuous))
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
private struct PipelineChipFlow: View {
    let chips: [PipelineChip]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(Array(chips.enumerated()), id: \.offset) { index, chip in
                PipelineChipView(chip: chip)
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

private struct PipelineChipView: View {
    let chip: PipelineChip

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
                .foregroundStyle(PipDesign.accent)
            Text(chip.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(PipDesign.ink)
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: false, vertical: wraps)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.white, in: shape)
        .overlay { shape.strokeBorder(PipDesign.line) }
    }
}

// MARK: - Flow layout

/// Left-aligned rows that wrap to the proposed width. A subview wider than a row is offered
/// the row width, so long chips wrap (or truncate, if they cap their lines) instead of overflowing.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = Self.finite(proposal.width)
        let arrangement = arrange(maxWidth: maxWidth, subviews: subviews)
        // Fill a finite proposal so placement wraps exactly as measured.
        return CGSize(width: maxWidth ?? arrangement.size.width, height: arrangement.size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let arrangement = arrange(maxWidth: bounds.width, subviews: subviews)
        for (index, frame) in arrangement.frames.enumerated() where index < subviews.count {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }

    private struct Arrangement {
        var frames: [CGRect]
        var size: CGSize
    }

    /// Greedy line breaking; each line's items are centred vertically on that line.
    private func arrange(maxWidth: CGFloat?, subviews: Subviews) -> Arrangement {
        let limit = maxWidth ?? .infinity
        var frames: [CGRect] = []
        var usedWidth: CGFloat = 0
        var lineStart = 0
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0

        func finishLine() {
            for index in lineStart..<frames.count {
                frames[index].origin.y = y + (lineHeight - frames[index].height) / 2
            }
            usedWidth = max(usedWidth, x)
        }

        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > limit {
                size = subview.sizeThatFits(ProposedViewSize(width: limit, height: nil))
                size.width = min(size.width, limit)
            }
            let lineHasItems = frames.count > lineStart
            let needed = lineHasItems ? x + spacing + size.width : size.width
            if lineHasItems && needed > limit + 0.5 {
                finishLine()
                y += lineHeight + lineSpacing
                lineStart = frames.count
                x = 0
                lineHeight = 0
            }
            let originX = frames.count > lineStart ? x + spacing : 0
            frames.append(CGRect(x: originX, y: y, width: size.width, height: size.height))
            x = originX + size.width
            lineHeight = max(lineHeight, size.height)
        }
        if !frames.isEmpty {
            finishLine()
        }
        let height = frames.isEmpty ? 0 : y + lineHeight
        return Arrangement(frames: frames, size: CGSize(width: usedWidth, height: height))
    }

    private static func finite(_ value: CGFloat?) -> CGFloat? {
        guard let value, value.isFinite else { return nil }
        return max(value, 0)
    }
}

// MARK: - Previews

private enum PipelineRevealPreview {
    /// The demo sentence's stages, `revealed` of them on screen. Without stages: still waiting on the server.
    @MainActor
    static func model(revealed: Int, withStages: Bool = true) -> AppModel {
        let model = AppModel.preview(withPlan: withStages)
        model.pipState = .thinking
        model.isRevealingPipeline = true
        model.pipelineStages = withStages ? SampleData.pipeline : []
        model.revealedStageCount = withStages ? min(revealed, SampleData.pipeline.count) : 0
        return model
    }
}

#Preview("Revealing") {
    ScrollView {
        PipelineRevealView()
            .padding(PipDesign.page)
    }
    .pipScreen()
    .environment(PipelineRevealPreview.model(revealed: 2))
}

#Preview("All stages") {
    ScrollView {
        PipelineRevealView()
            .padding(PipDesign.page)
    }
    .pipScreen()
    .environment(PipelineRevealPreview.model(revealed: 4))
}

#Preview("Waiting") {
    ScrollView {
        PipelineRevealView()
            .padding(PipDesign.page)
    }
    .pipScreen()
    .environment(PipelineRevealPreview.model(revealed: 0, withStages: false))
}
