import Charts
import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
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
            VStack(alignment: .leading, spacing: 28) {
                titleBlock.pipCard(emphasized: true)
                if !facts.isEmpty {
                    factsSection.pipCard()
                }
                if !item.evidence.isEmpty {
                    evidenceSection.pipCard()
                }
                if !item.curve.isEmpty {
                    curveSection.pipCard()
                }
                if item.taskId != nil {
                    actionsSection
                }
            }
            .padding(20)
        }
        .pipScreen()
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.actionMessage = nil
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.title)
                .font(.title2.bold())
            Text(item.action)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            Text(item.why)
                .font(.subheadline)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let flag = item.flag {
                FlagPill(flag: flag)
            }
        }
    }

    private var factsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(facts) { fact in
                VStack(spacing: 0) {
                    if fact.id != facts.first?.id {
                        Divider()
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(fact.label)
                            .font(.subheadline)
                            .foregroundStyle(PipDesign.secondary)
                            .frame(width: 110, alignment: .leading)
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

    private var evidenceSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Why this comes first")
                .font(.headline)
            ForEach(Array(item.evidence.enumerated()), id: \.offset) { pair in
                EvidenceRow(evidence: pair.element)
            }
        }
    }

    private var curveSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Cost of waiting")
                .font(.headline)
            Text(curveCaption)
                .font(.footnote)
                .foregroundStyle(PipDesign.secondary)
            CostCurveChart(points: item.curve, hoursToDue: hoursToDue)
                .frame(height: 200)
        }
    }

    private var curveCaption: String {
        let kind = item.curveKind?.label ?? "Curve"
        return "\(kind) curve: how much it costs to postpone this by a number of hours."
    }

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                actionButton("Done", systemImage: "checkmark", kind: .done)
                actionButton("Defer", systemImage: "clock.arrow.circlepath", kind: .deferTask)
                actionButton("Drop", systemImage: "xmark", kind: .drop)
            }
            if let message = model.actionMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
            }
        }
    }

    private func actionButton(_ title: String, systemImage: String, kind: ActionKind) -> some View {
        Button {
            model.record(kind: kind, item: item)
        } label: {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tint(kind == .drop ? Color.red : Color.accentColor)
    }
}

private struct EvidenceRow: View {
    let evidence: RuleEvidence

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: evidence.fired ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(evidence.fired ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(evidence.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(evidence.fired ? Color.primary : Color.secondary)
                Text(evidence.detail)
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
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
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2.5))
            }

            if let dueMarker {
                RuleMark(x: .value("Due", dueMarker))
                    .foregroundStyle(Color.red.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .annotation(position: .top, alignment: .leading) {
                        Text("Due")
                            .font(.caption2)
                            .foregroundStyle(Color.red)
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
