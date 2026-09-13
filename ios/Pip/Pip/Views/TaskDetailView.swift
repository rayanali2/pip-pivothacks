import Charts
import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let item: PlanItem
    let task: UniMateTask?
    /// reasoning.now of the plan the item came from (scenario clock); nil uses the real clock.
    var planNow: String? = nil

    private struct Fact: Identifiable {
        let label: String
        let value: String
        var id: String { label }
    }

    private var facts: [Fact] {
        var result: [Fact] = []
        if let category = task?.category ?? item.category {
            result.append(Fact(label: "Category", value: category.label))
        }
        if let dueAt = task?.dueAt ?? item.dueAt, let when = DateFormatting.dayTime(dueAt) {
            result.append(Fact(label: "Due", value: when))
        }
        if let money = task?.moneyAtRisk ?? item.moneyAtRisk, money > 0 {
            result.append(Fact(label: "Money at risk", value: MoneyFormatting.dollars(money)))
        }
        if let minutes = task?.estMinutes ?? item.estMinutes {
            result.append(Fact(label: "Full task", value: "\(minutes) min"))
        }
        if let minutes = PlanVisuals.windowMinutes(item) {
            result.append(Fact(label: "This block", value: "\(minutes) min"))
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
            VStack(alignment: .leading, spacing: 18) {
                titleBlock.uniMateCard(emphasized: true)
                if item.taskId != nil { actionsSection }
                if !facts.isEmpty {
                    factsSection.uniMateCard()
                }
                if !item.evidence.isEmpty {
                    evidenceSection.uniMateCard()
                }
                if !item.curve.isEmpty {
                    curveSection.uniMateCard()
                }
                if let task {
                    PlanDisclosure(title: "Original capture", text: task.rawText + "\n\n" + task.normalizedText, symbol: "text.bubble")
                        .uniMateCard()
                }
            }
            .padding(20)
        }
        .uniMateScreen()
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.actionMessage = nil
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                TaskGlyph(category: task?.category ?? item.category, fixed: item.kind == .fixedBlock, size: 54)
                Spacer()
                if let flag = item.flag { FlagPill(flag: flag) }
            }
            Text(item.title).font(.system(.title, design: .rounded, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)
            Text(item.action).font(.subheadline).foregroundStyle(UniMateDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
            PlanDisclosure(title: "Why this task", text: item.why, symbol: "sparkle")
        }
    }

    private var factsSection: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), alignment: .topLeading)], alignment: .leading, spacing: 18) {
            ForEach(facts) { fact in
                VStack(alignment: .leading, spacing: 6) {
                    Label(fact.label, systemImage: factSymbol(fact.label))
                        .font(.caption).foregroundStyle(UniMateDesign.secondary)
                    Text(fact.value).font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func factSymbol(_ label: String) -> String {
        switch label {
        case "Due": return "calendar"
        case "Money at risk": return "creditcard"
        case "Full task", "This block": return "timer"
        case "Deferred": return "arrow.uturn.right"
        default: return "square.grid.2x2"
        }
    }

    private var evidenceSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Priority signals")
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
            HStack {
                PlanTag(text: item.curveKind?.label ?? "Cost curve", symbol: "chart.xyaxis.line")
                Spacer()
                Text("If you postpone").font(.caption).foregroundStyle(UniMateDesign.secondary)
            }
            CostCurveChart(points: item.curve, hoursToDue: hoursToDue)
                .frame(height: 200)
        }
    }

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                actionButton("Done", systemImage: "checkmark", kind: .done)
                actionButton("Defer", systemImage: "clock.arrow.circlepath", kind: .deferTask)
                actionButton("Drop", systemImage: "xmark", kind: .drop)
            }
            VStack(spacing: 10) {
                actionButton("Done", systemImage: "checkmark", kind: .done)
                actionButton("Defer", systemImage: "clock.arrow.circlepath", kind: .deferTask)
                actionButton("Drop", systemImage: "xmark", kind: .drop)
            }
            }
            if let message = model.actionMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(UniMateDesign.secondary)
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

    private var shortLabel: String {
        switch evidence.rule {
        case .irreversibleLoss: return "Deadline & money"
        case .fixedBlockCollision: return "Class overlap"
        case .basicNeeds: return "Basic needs"
        case .fitsWindow: return "Time fit"
        case .academicDeadline: return "Academic deadline"
        case .unknown: return evidence.label
        }
    }

    var body: some View {
        DisclosureGroup {
            Text(evidence.detail).font(.footnote).foregroundStyle(UniMateDesign.secondary)
                .fixedSize(horizontal: false, vertical: true).padding(.vertical, 6)
        } label: {
            Label(shortLabel, systemImage: evidence.fired ? "checkmark.circle.fill" : "minus.circle")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(evidence.fired ? UniMateDesign.accent : UniMateDesign.secondary)
                .frame(minHeight: 36)
        }
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
                AreaMark(x: .value("Hours", point.hours), y: .value("Cost", point.cost))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(UniMateDesign.accent.opacity(0.08))
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
