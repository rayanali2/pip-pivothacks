import Charts
import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var chartHeight: CGFloat = 190
    let item: PlanItem
    let task: PipTask?
    /// reasoning.now of the plan the item came from (scenario clock); nil uses the real clock.
    var planNow: String? = nil

    private struct Fact: Identifiable {
        let label: String
        let value: String
        var id: String { label }
    }

    private var facts: [Fact] {
        var result: [Fact] = []
        if let task {
            result.append(Fact(label: "You said", value: task.rawText))
            result.append(Fact(label: "Pip heard", value: task.normalizedText))
        }
        if let category = task?.category ?? item.category {
            result.append(Fact(label: "Category", value: category.label))
        }
        if let dueAt = task?.dueAt ?? item.dueAt, let when = DateFormatting.dayTime(dueAt) {
            var value = when
            if let relative = DateFormatting.relative(dueAt, from: planNow) {
                value += " (\(relative))"
            }
            result.append(Fact(label: "Due", value: value))
        }
        if let money = task?.moneyAtRisk ?? item.moneyAtRisk, money > 0 {
            result.append(Fact(label: "Money at risk", value: MoneyFormatting.dollars(money)))
        }
        if let minutes = task?.estMinutes ?? item.estMinutes {
            result.append(Fact(label: "Estimated", value: "\(minutes) min"))
        }
        if let deferCount = task?.deferCount, deferCount > 0 {
            result.append(Fact(label: "Deferred", value: deferCount == 1 ? "once" : "\(deferCount) times"))
        }
        return result
    }

    private var hoursToDue: Double? {
        guard let due = DateFormatting.parse(task?.dueAt ?? item.dueAt) else { return nil }
        let reference = DateFormatting.parse(planNow) ?? Date()
        return due.timeIntervalSince(reference) / 3600
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PipDesign.gap) {
                titleBlock.pipCard()
                if item.taskId != nil {
                    actionsSection
                }
                if !facts.isEmpty {
                    factsSection.pipCard()
                }
                if !item.evidence.isEmpty {
                    evidenceSection.pipCard()
                }
                if !item.curve.isEmpty {
                    curveSection.pipCard()
                }
            }
            .padding(.horizontal, PipDesign.page)
            .padding(.vertical, 12)
        }
        .pipScreen()
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.actionMessage = nil
        }
    }

    // MARK: Title

    private var estimatedMinutes: Int? {
        task?.estMinutes ?? item.estMinutes
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(item.title)
                .font(PipDesign.title)
                .fixedSize(horizontal: false, vertical: true)
            Text(item.action)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            if item.flag != nil || estimatedMinutes != nil {
                PipFlowLayout {
                    if let flag = item.flag {
                        FlagPill(flag: flag)
                    }
                    if let minutes = estimatedMinutes {
                        PipPill(text: "\(minutes) min", systemImage: "timer")
                    }
                }
            }
            Text(item.why)
                .font(.subheadline)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Facts

    private var stacksFacts: Bool {
        typeSize.isAccessibilitySize
    }

    private var factLayout: AnyLayout {
        stacksFacts
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
    }

    private var factsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(facts) { fact in
                VStack(spacing: 0) {
                    if fact.id != facts.first?.id {
                        Divider()
                    }
                    factLayout {
                        Text(fact.label)
                            .font(stacksFacts ? .footnote : .subheadline)
                            .foregroundStyle(PipDesign.secondary)
                            .frame(width: stacksFacts ? nil : 110, alignment: .leading)
                        Text(fact.value)
                            .font(.subheadline)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 10)
                }
            }
        }
    }

    // MARK: Evidence

    private var evidenceSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Why it’s ranked here", systemImage: "checklist")
                .labelStyle(PipCompactLabelStyle())
                .pipEyebrow()
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(item.evidence.enumerated()), id: \.offset) { pair in
                EvidenceRow(evidence: pair.element)
            }
        }
    }

    // MARK: Curve

    private var curveSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Cost of waiting", systemImage: "chart.line.uptrend.xyaxis")
                .labelStyle(PipCompactLabelStyle())
                .pipEyebrow()
                .accessibilityAddTraits(.isHeader)
            if let kind = item.curveKind, kind != .unknown {
                PipPill(text: "\(kind.label) curve", systemImage: "chart.xyaxis.line", tint: PipDesign.secondary)
            }
            CostCurveChart(points: item.curve, hoursToDue: hoursToDue)
                .frame(height: min(chartHeight, 320))
                .padding(.top, 4)
        }
    }

    // MARK: Actions

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    actionButtons
                }
                VStack(spacing: 10) {
                    actionButtons
                }
            }
            if let message = model.actionMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        actionButton("Done", systemImage: "checkmark", kind: .done)
        actionButton("Defer", systemImage: "clock.arrow.circlepath", kind: .deferTask)
        actionButton("Drop", systemImage: "xmark", kind: .drop)
    }

    private func actionButton(_ title: String, systemImage: String, kind: ActionKind) -> some View {
        let button = Button {
            model.record(kind: kind, item: item)
        } label: {
            Label(title, systemImage: systemImage)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
        }
        return styledActionButton(button, kind: kind)
            .controlSize(.large)
            .tint(kind == .drop ? PipDesign.danger : PipDesign.accent)
    }

    /// Done is the primary action; Defer and Drop stay secondary.
    @ViewBuilder
    private func styledActionButton<ButtonLabel: View>(_ button: Button<ButtonLabel>, kind: ActionKind) -> some View {
        if kind == .done {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}

private struct EvidenceRow: View {
    let evidence: RuleEvidence

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: evidence.fired ? "checkmark.circle.fill" : "circle")
                .font(.body.weight(.semibold))
                .foregroundStyle(evidence.fired ? PipDesign.accent : PipDesign.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(evidence.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(evidence.fired ? PipDesign.ink : PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(evidence.detail)
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(evidence.fired ? "Applies" : "Doesn’t apply")
    }
}

private struct CostCurveChart: View {
    let points: [CurvePoint]
    let hoursToDue: Double?

    private var minHours: Double {
        points.map { $0.hours }.min() ?? 0
    }

    private var maxHours: Double {
        points.map { $0.hours }.max() ?? 48
    }

    private var dueMarker: Double? {
        guard let hoursToDue, hoursToDue >= minHours, hoursToDue <= maxHours else { return nil }
        return hoursToDue
    }

    var body: some View {
        Chart {
            ForEach(points) { point in
                LineMark(
                    x: .value("Hours", point.hours),
                    y: .value("Cost", point.cost)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(PipDesign.accent)
                .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
            }

            if let dueMarker {
                RuleMark(x: .value("Due", dueMarker))
                    .foregroundStyle(PipDesign.danger.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("Due")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(PipDesign.danger)
                    }
            }
        }
        .chartYScale(domain: 0.0...1.0)
        .chartXAxisLabel("Hours from now")
        .chartYAxisLabel("Cost")
    }
}

#Preview("Task detail") {
    NavigationStack {
        TaskDetailView(
            item: SampleData.plan!.doNow!,
            task: SampleData.tasks.first,
            planNow: SampleData.plan!.reasoning.now
        )
    }
    .environment(AppModel.preview())
}
