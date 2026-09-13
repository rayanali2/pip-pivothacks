import Charts
import SwiftUI

/// The stakes under the do-now title: a live countdown to the deadline, the cost-of-waiting
/// sparkline and the five ranking rules as chips. Each part shows only when the item has its data.
struct DoNowStakesStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let item: PlanItem
    /// reasoning.now of the plan the item came from (scenario clock)
    let planNow: String

    /// Index into item.evidence whose detail line is showing.
    @State private var expandedRule: Int? = nil

    private var dueDate: Date? {
        DateFormatting.parse(item.dueAt)
    }

    /// Hours from plan time to the deadline, the same axis as item.curve.
    private var hoursToDue: Double? {
        guard let due = dueDate else { return nil }
        let reference = DateFormatting.parse(planNow) ?? model.scenarioNow(at: Date())
        return due.timeIntervalSince(reference) / 3600
    }

    private var firedCount: Int {
        item.evidence.filter { $0.fired }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let due = dueDate {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    DoNowCountdownLine(
                        item: item,
                        planNow: planNow,
                        remaining: due.timeIntervalSince(clock(at: context.date))
                    )
                }
            }
            if !item.curve.isEmpty {
                DoNowCostSparkline(points: item.curve, kind: item.curveKind, hoursToDue: hoursToDue)
            }
            if !item.evidence.isEmpty {
                rulesSection
            }
        }
        .onChange(of: item.itemId) {
            expandedRule = nil
        }
    }

    /// The scenario clock ticking forward from the current plan; frozen at planNow for any other plan.
    private func clock(at date: Date) -> Date {
        if model.currentPlan?.reasoning.now != planNow, let frozen = DateFormatting.parse(planNow) {
            return frozen
        }
        return model.scenarioNow(at: date)
    }

    // MARK: Rules

    private var rulesSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("RULES · \(firedCount) OF \(item.evidence.count) FIRED")
                .font(.caption2.weight(.bold))
                .tracking(1)
                .foregroundStyle(UniMateDesign.secondary)
                .accessibilityLabel("\(firedCount) of \(item.evidence.count) rules fired")
            ViewThatFits(in: .horizontal) {
                chipRow
                ScrollView(.horizontal, showsIndicators: false) {
                    chipRow
                }
            }
            if let index = expandedRule, item.evidence.indices.contains(index) {
                ruleDetail(item.evidence[index])
                    .transition(.opacity)
            }
        }
    }

    private var chipRow: some View {
        HStack(spacing: 6) {
            ForEach(Array(item.evidence.enumerated()), id: \.offset) { pair in
                ruleChip(pair.element, index: pair.offset)
            }
        }
    }

    private func ruleChip(_ evidence: RuleEvidence, index: Int) -> some View {
        let isExpanded = expandedRule == index
        let name = Self.shortLabel(for: evidence)
        let border: Color = evidence.fired
            ? UniMateDesign.accent.opacity(isExpanded ? 0.6 : 0.2)
            : (isExpanded ? UniMateDesign.secondary.opacity(0.6) : UniMateDesign.line)
        return Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                expandedRule = isExpanded ? nil : index
            }
        } label: {
            HStack(spacing: 4) {
                if evidence.fired {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                }
                Text(name)
                    .lineLimit(1)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(evidence.fired ? UniMateDesign.accent : UniMateDesign.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(evidence.fired ? UniMateDesign.accent.opacity(0.12) : UniMateDesign.surface))
            .overlay {
                Capsule().strokeBorder(border, lineWidth: isExpanded ? 1.5 : 1)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name) rule, \(evidence.fired ? "fired" : "not fired")")
        .accessibilityHint(isExpanded ? "Hides the detail" : "Shows the detail")
        .accessibilityAddTraits(isExpanded ? AccessibilityTraits.isSelected : [])
    }

    private func ruleDetail(_ evidence: RuleEvidence) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: evidence.fired ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(evidence.fired ? UniMateDesign.accent : UniMateDesign.secondary)
            Text(evidence.detail)
                .foregroundStyle(UniMateDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Self.shortLabel(for: evidence)) rule: \(evidence.detail)")
    }

    private static func shortLabel(for evidence: RuleEvidence) -> String {
        switch evidence.rule {
        case .irreversibleLoss: return "Loss"
        case .fixedBlockCollision: return "Class clash"
        case .basicNeeds: return "Basics"
        case .fitsWindow: return "Fits now"
        case .academicDeadline: return "Deadline"
        case .unknown: return evidence.label
        }
    }
}

/// "$79 refund gone in 3h 46m · 5:00 PM", "Due in 1d 10h · Tue 11:59 PM" or "Past due".
private struct DoNowCountdownLine: View {
    let item: PlanItem
    let planNow: String
    /// seconds until the deadline on the scenario clock; <= 0 is past due
    let remaining: TimeInterval

    private var dueTime: String? {
        DateFormatting.smartTime(item.dueAt, relativeTo: planNow)
    }

    /// "$79 refund gone" or "$79 at risk"; nil when nothing is at risk.
    private var stake: String? {
        guard let money = item.moneyAtRisk, money > 0 else { return nil }
        let amount = MoneyFormatting.dollars(money)
        let losesRefund = item.title.localizedCaseInsensitiveContains("refund")
            || item.title.localizedCaseInsensitiveContains("return")
        return losesRefund ? "\(amount) refund gone" : "\(amount) at risk"
    }

    private var text: String {
        let lead: String
        if remaining <= 0 {
            lead = "Past due"
        } else if let stake {
            lead = "\(stake) in \(DoNowDuration.compact(remaining))"
        } else {
            lead = "Due in \(DoNowDuration.compact(remaining))"
        }
        guard let dueTime else { return lead }
        return "\(lead) · \(dueTime)"
    }

    private var spokenText: String {
        let lead: String
        if remaining <= 0 {
            lead = "Past due"
        } else if let stake {
            lead = "\(stake) in \(DoNowDuration.spoken(remaining))"
        } else {
            lead = "Due in \(DoNowDuration.spoken(remaining))"
        }
        guard let dueTime else { return lead }
        return "\(lead), at \(dueTime)"
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "hourglass")
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote.weight(.semibold).monospacedDigit())
        .foregroundStyle(remaining < 2 * 3600 ? UniMateDesign.warning : UniMateDesign.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenText)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// Countdown text: days and hours past a day, hours and minutes under it, seconds only under 10 minutes.
private enum DoNowDuration {
    private struct Parts {
        let days: Int
        let hours: Int
        let minutes: Int
        let seconds: Int
        let total: Int
    }

    private static func parts(_ interval: TimeInterval) -> Parts {
        // Bounded so a far-off deadline can never overflow Int.
        let clamped = interval.isFinite ? min(max(interval, 0), 1_000_000_000) : 0
        let total = Int(clamped)
        return Parts(
            days: total / 86_400,
            hours: (total % 86_400) / 3600,
            minutes: (total % 3600) / 60,
            seconds: total % 60,
            total: total
        )
    }

    /// "1d 10h", "3h 46m", "46m", "9m 05s", "42s"
    static func compact(_ interval: TimeInterval) -> String {
        let p = parts(interval)
        if p.days > 0 {
            return p.hours > 0 ? "\(p.days)d \(p.hours)h" : "\(p.days)d"
        }
        if p.total < 600 {
            let seconds = p.seconds < 10 ? "0\(p.seconds)" : "\(p.seconds)"
            return p.minutes > 0 ? "\(p.minutes)m \(seconds)s" : "\(p.seconds)s"
        }
        return p.hours > 0 ? "\(p.hours)h \(p.minutes)m" : "\(p.minutes)m"
    }

    /// "1 day 10 hours", "3 hours 46 minutes", "9 minutes 5 seconds"
    static func spoken(_ interval: TimeInterval) -> String {
        let p = parts(interval)
        var words: [String] = []
        if p.days > 0 {
            words.append(unit(p.days, "day"))
            if p.hours > 0 { words.append(unit(p.hours, "hour")) }
        } else if p.total < 600 {
            if p.minutes > 0 { words.append(unit(p.minutes, "minute")) }
            words.append(unit(p.seconds, "second"))
        } else {
            if p.hours > 0 { words.append(unit(p.hours, "hour")) }
            words.append(unit(p.minutes, "minute"))
        }
        return words.joined(separator: " ")
    }

    private static func unit(_ value: Int, _ word: String) -> String {
        value == 1 ? "1 \(word)" : "\(value) \(word)s"
    }
}

/// Small cost-of-waiting chart: item.curve over hours of postponement, with the deadline dashed.
private struct DoNowCostSparkline: View {
    let points: [CurvePoint]
    let kind: DecayCurve?
    /// hours from plan time to the deadline
    let hoursToDue: Double?

    private var kindLabel: String {
        (kind ?? .unknown).label
    }

    private var dueMarker: Double? {
        guard let hoursToDue,
              let first = points.map({ $0.hours }).min(),
              let last = points.map({ $0.hours }).max(),
              hoursToDue >= first, hoursToDue <= last else { return nil }
        return hoursToDue
    }

    private var spokenSummary: String {
        guard let first = points.first, let peak = points.map({ $0.cost }).max() else { return "" }
        let start = Self.percent(first.cost)
        if peak > first.cost, let reached = points.first(where: { $0.cost >= peak }) {
            return "Starts at \(start) percent and reaches \(Self.percent(peak)) percent after \(Self.hoursText(reached.hours))"
        }
        return "Stays at \(start) percent"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("COST OF WAITING")
                    .font(.caption2.weight(.bold))
                    .tracking(1)
                Text(kindLabel)
                    .font(.caption2)
            }
            .foregroundStyle(UniMateDesign.secondary)

            Chart {
                ForEach(points) { point in
                    AreaMark(
                        x: .value("Hours", point.hours),
                        y: .value("Cost", point.cost)
                    )
                    .interpolationMethod(.monotone)
                    .foregroundStyle(UniMateDesign.accent.opacity(0.12))

                    LineMark(
                        x: .value("Hours", point.hours),
                        y: .value("Cost", point.cost)
                    )
                    .interpolationMethod(.monotone)
                    .foregroundStyle(UniMateDesign.accent)
                    .lineStyle(StrokeStyle(lineWidth: 2))
                }

                if let dueMarker {
                    RuleMark(x: .value("Due", dueMarker))
                        .foregroundStyle(UniMateDesign.warning.opacity(0.7))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .chartYScale(domain: 0.0...1.0)
            .frame(height: 44)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Cost of waiting, \(kindLabel) curve")
        .accessibilityValue(spokenSummary)
    }

    private static func percent(_ cost: Double) -> Int {
        Int((min(max(cost, 0), 1) * 100).rounded())
    }

    private static func hoursText(_ hours: Double) -> String {
        guard hours.isFinite, abs(hours) < 1_000_000 else { return "a while" }
        if hours == 1 { return "1 hour" }
        let value = hours.rounded() == hours ? "\(Int(hours))" : String(format: "%.1f", hours)
        return "\(value) hours"
    }
}

#Preview("Do-now stakes") {
    DoNowStakesPreview()
        .environment(AppModel.preview())
}

private struct DoNowStakesPreview: View {
    var body: some View {
        if let plan = SampleData.plan, let item = plan.doNow {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(item.title)
                        .font(UniMateDesign.heading)
                    DoNowStakesStrip(item: item, planNow: plan.reasoning.now)
                }
                .uniMateCard(emphasized: true)
                .padding(UniMateDesign.page)
            }
            .uniMateScreen()
        } else {
            Text("No sample plan")
        }
    }
}
