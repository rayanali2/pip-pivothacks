import SwiftUI

enum PipDesign {
    static let ink = Color(red: 0.13, green: 0.15, blue: 0.22)
    static let secondary = Color(red: 0.37, green: 0.39, blue: 0.46)
    static let background = Color(red: 0.976, green: 0.969, blue: 0.953)
    static let surface = Color(red: 1.0, green: 0.996, blue: 0.99)
    static let accent = Color(red: 0.34, green: 0.39, blue: 0.70)
    static let mist = Color(red: 0.925, green: 0.933, blue: 0.98)
    static let line = Color(red: 0.885, green: 0.88, blue: 0.87)
    /// Stronger hairline for text inputs so fields stay findable.
    static let fieldLine = Color(red: 0.76, green: 0.765, blue: 0.79)
    static let positive = Color(red: 0.19, green: 0.43, blue: 0.34)
    static let warning = Color(red: 0.58, green: 0.34, blue: 0.12)
    static let danger = Color(red: 0.69, green: 0.23, blue: 0.21)
    static let page: CGFloat = 20
    static let gap: CGFloat = 20
    static let radius: CGFloat = 20
    static let radiusSmall: CGFloat = 14
    static let title = Font.system(.title2, design: .rounded, weight: .bold)
    static let heading = Font.system(.title3, design: .rounded, weight: .semibold)
    static let eyebrow = Font.caption2.weight(.bold)
}

private struct PipCardStyle: ViewModifier {
    var emphasized: Bool

    func body(content: Content) -> some View {
        content
            .padding(emphasized ? PipDesign.page : 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PipDesign.surface, in: RoundedRectangle(cornerRadius: PipDesign.radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: PipDesign.radius, style: .continuous)
                    .strokeBorder(emphasized ? PipDesign.accent.opacity(0.28) : PipDesign.line, lineWidth: emphasized ? 1.5 : 1)
            }
            .shadow(color: (emphasized ? PipDesign.accent : PipDesign.ink).opacity(emphasized ? 0.08 : 0.03),
                    radius: emphasized ? 16 : 8, y: emphasized ? 8 : 3)
    }
}

extension View {
    func pipCard(emphasized: Bool = false) -> some View {
        modifier(PipCardStyle(emphasized: emphasized))
    }

    func pipScreen() -> some View {
        background(PipDesign.background.ignoresSafeArea())
            .foregroundStyle(PipDesign.ink)
            .toolbarBackground(PipDesign.background, for: .navigationBar)
    }

    /// Small uppercase label that sits above a value or a card's main line.
    func pipEyebrow(_ color: Color = PipDesign.secondary) -> some View {
        font(PipDesign.eyebrow)
            .tracking(0.9)
            .textCase(.uppercase)
            .foregroundStyle(color)
    }
}

/// Compact capsule: optional SF Symbol plus a short label.
struct PipPill: View {
    let text: String
    var systemImage: String? = nil
    var tint: Color = PipDesign.accent
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At accessibility sizes the pill wraps instead of truncating, so it becomes a rounded tag.
        let wraps = typeSize.isAccessibilitySize
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small).accessibilityHidden(true) }
            Text(text)
                .lineLimit(wraps ? nil : 1)
                .fixedSize(horizontal: false, vertical: wraps)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: wraps ? 10 : 999, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Lays pills out left to right and wraps to a new line, so metadata never clips on small iPhones.
struct PipFlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
            if x > 0 && x + size.width > maxWidth {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
            }
            widest = max(widest, x + size.width)
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: min(widest, maxWidth), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += lineHeight + lineSpacing
                x = bounds.minX
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                          proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

struct SectionHeading: View {
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(PipDesign.heading)
            if let subtitle {
                Text(subtitle).font(.footnote).foregroundStyle(PipDesign.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct PipStatusView: View {
    let symbol: String
    let title: String
    let detail: String
    var loading = false
    @ScaledMetric(relativeTo: .subheadline) private var badge: CGFloat = 34

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Group {
                if loading {
                    ProgressView().tint(PipDesign.accent)
                } else {
                    Image(systemName: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(PipDesign.accent)
                }
            }
            .frame(width: badge, height: badge)
            .background(PipDesign.mist, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Uses the same snapshot as the visible recommendation, including the scenario clock.
struct HomeContextStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let plan = model.contextPlan, !model.hasCapture, !model.isOffline {
            ContextStrip(plan: plan)
        } else if let timetable = model.todayTimetable {
            let window = model.currentPlan?.reasoning.freeWindow ?? timetable.nextFreeWindow
            let now = model.currentPlan?.reasoning.now ?? timetable.now
            ContextFacts(
                now: DateFormatting.time(now) ?? "—",
                next: window?.nextBlockTitle ?? "No upcoming class",
                time: DateFormatting.time(window?.nextBlockStartsAt),
                minutes: model.currentPlan?.reasoning.context.availableMinutes ?? window?.minutes
            )
        }
    }
}

struct ContextFacts: View {
    let now: String
    let next: String
    let time: String?
    let minutes: Int?
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var dividerHeight: CGFloat = 34

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            fact("Now", symbol: "clock", value: now)
            divider(hidden: stacked)
            fact("Next class", symbol: "graduationcap", value: next, detail: time)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let minutes {
                divider(hidden: stacked)
                fact("Free", symbol: "hourglass", value: "\(minutes) min", tint: PipDesign.accent)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(PipDesign.surface, in: RoundedRectangle(cornerRadius: PipDesign.radiusSmall, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: PipDesign.radiusSmall, style: .continuous).strokeBorder(PipDesign.line) }
    }

    @ViewBuilder
    private func divider(hidden: Bool) -> some View {
        if !hidden {
            Rectangle().fill(PipDesign.line).frame(width: 1, height: dividerHeight)
        }
    }

    private func fact(_ label: String, symbol: String, value: String, detail: String? = nil, tint: Color = PipDesign.ink) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(label, systemImage: symbol)
                .labelStyle(PipCompactLabelStyle())
                .pipEyebrow()
            Text(value).font(.subheadline.weight(.semibold)).foregroundStyle(tint)
                .fixedSize(horizontal: false, vertical: true)
            if let detail { Text(detail).font(.caption.monospacedDigit()).foregroundStyle(PipDesign.secondary) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Icon and title with tight spacing, for eyebrows and pills.
struct PipCompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}

struct RecordingStatus: View {
    @State private var startedAt = Date()
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: 8))
        let shape = RoundedRectangle(cornerRadius: stacked ? PipDesign.radiusSmall : 999, style: .continuous)
        layout {
            HStack(spacing: 8) {
                Circle().fill(PipDesign.danger).frame(width: 7, height: 7)
                Text("Listening").fontWeight(.semibold).foregroundStyle(PipDesign.ink)
            }
            Text(startedAt, style: .timer).monospacedDigit().fixedSize()
            Text("· release to send")
        }
        .font(.footnote)
        .foregroundStyle(PipDesign.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(PipDesign.surface, in: shape)
        .overlay { shape.strokeBorder(PipDesign.line) }
        .accessibilityElement(children: .combine)
    }
}
