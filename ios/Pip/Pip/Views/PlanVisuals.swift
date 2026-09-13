import SwiftUI

/// Compact components used only by the plan, context, schedule, history and detail pages.
enum PlanVisuals {
    static func symbol(for category: TaskCategory?) -> String {
        switch category {
        case .classSession: return "graduationcap.fill"
        case .assignment: return "doc.text.fill"
        case .errand: return "bag.fill"
        case .meal: return "fork.knife"
        case .money: return "creditcard.fill"
        case .work: return "briefcase.fill"
        case .club, .social: return "person.2.fill"
        case .rest: return "moon.fill"
        default: return "checklist"
        }
    }

    static func windowMinutes(_ item: PlanItem) -> Int? {
        if let start = DateFormatting.parse(item.startsAt), let end = DateFormatting.parse(item.endsAt), end > start {
            return Int(end.timeIntervalSince(start) / 60)
        }
        return nil
    }
}

struct TaskGlyph: View {
    let category: TaskCategory?
    var fixed = false
    var size: CGFloat = 44

    var body: some View {
        Image(systemName: fixed ? "graduationcap.fill" : PlanVisuals.symbol(for: category))
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(UniMateDesign.accent)
            .frame(width: size, height: size)
            .background(UniMateDesign.mist, in: RoundedRectangle(cornerRadius: size * 0.32))
            .accessibilityHidden(true)
    }
}

struct PlanTag: View {
    let text: String
    let symbol: String
    var tint: Color = UniMateDesign.accent

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(tint.opacity(0.09), in: Capsule())
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct TaskMetadata: View {
    let item: PlanItem
    let now: String?

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { tags }
            VStack(alignment: .leading, spacing: 8) { tags }
        }
    }

    @ViewBuilder private var tags: some View {
        if let minutes = PlanVisuals.windowMinutes(item) {
            PlanTag(text: "\(minutes) min", symbol: "timer")
        }
        if let due = DateFormatting.smartTime(item.dueAt, relativeTo: now) {
            PlanTag(text: "Due \(due)", symbol: "calendar")
        }
        if let money = item.moneyAtRisk, money > 0 {
            PlanTag(text: "\(MoneyFormatting.dollars(money)) at risk", symbol: "exclamationmark", tint: UniMateDesign.warning)
        }
    }
}

/// A time-allocation indicator, never an invented completion percentage.
struct WindowFitView: View {
    let used: Int
    let available: Int
    var compact = false

    private var fits: Bool { used <= available }
    private var tint: Color { fits ? UniMateDesign.accent : UniMateDesign.warning }
    private var fraction: Double { min(1, max(0, Double(used) / Double(max(1, available)))) }

    var body: some View {
        HStack(spacing: 14) {
            if !compact {
                ZStack {
                    Circle().stroke(tint.opacity(0.12), lineWidth: 6)
                    Circle().trim(from: 0, to: fraction)
                        .stroke(tint, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Image(systemName: fits ? "timer" : "exclamationmark")
                        .font(.title3.weight(.medium)).foregroundStyle(tint)
                }
                .frame(width: 48, height: 48).padding(3).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("\(used) / \(available) min").font(.subheadline.weight(.semibold)).monospacedDigit()
                    Spacer(minLength: 6)
                    Text(fits ? "\(available - used) min spare" : "\(used - available) min over")
                        .font(.caption.weight(.medium)).foregroundStyle(tint)
                }
                ProgressView(value: fraction).tint(tint)
                    .accessibilityLabel("Time needed")
                    .accessibilityValue("\(used) of \(available) minutes")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct PlanDisclosure: View {
    let title: String
    let text: String
    var symbol = "text.alignleft"

    var body: some View {
        DisclosureGroup {
            Text(text).font(.subheadline).foregroundStyle(UniMateDesign.secondary)
                .fixedSize(horizontal: false, vertical: true).padding(.vertical, 8)
        } label: {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.medium)).foregroundStyle(UniMateDesign.ink)
                .frame(minHeight: 36)
        }
    }
}
