import SwiftUI

enum UniMateDesign {
    static let ink = Color(red: 0.13, green: 0.16, blue: 0.24)
    static let secondary = Color(red: 0.36, green: 0.39, blue: 0.47)
    static let background = Color(red: 0.98, green: 0.975, blue: 0.96)
    static let accent = Color(red: 0.34, green: 0.39, blue: 0.70)
    static let mist = Color(red: 0.92, green: 0.93, blue: 0.98)
    static let line = Color(red: 0.87, green: 0.88, blue: 0.92)
    static let positive = Color(red: 0.19, green: 0.43, blue: 0.34)
    static let warning = Color(red: 0.58, green: 0.34, blue: 0.12)
    static let page: CGFloat = 20
    static let gap: CGFloat = 24
    static let radius: CGFloat = 24
    static let title = Font.system(.largeTitle, design: .rounded, weight: .bold)
    static let heading = Font.system(.title2, design: .rounded, weight: .bold)
}

private struct UniMateCardStyle: ViewModifier {
    var emphasized: Bool

    func body(content: Content) -> some View {
        content
            .padding(UniMateDesign.page)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(emphasized ? UniMateDesign.mist : Color.white,
                        in: RoundedRectangle(cornerRadius: UniMateDesign.radius))
            .overlay {
                RoundedRectangle(cornerRadius: UniMateDesign.radius)
                    .strokeBorder(emphasized ? UniMateDesign.accent.opacity(0.2) : UniMateDesign.line.opacity(0.7))
            }
            .shadow(color: UniMateDesign.ink.opacity(0.035), radius: 12, y: 5)
    }
}

extension View {
    func uniMateCard(emphasized: Bool = false) -> some View {
        modifier(UniMateCardStyle(emphasized: emphasized))
    }

    func uniMateScreen() -> some View {
        background(UniMateDesign.background.ignoresSafeArea())
            .foregroundStyle(UniMateDesign.ink)
            .toolbarBackground(UniMateDesign.background, for: .navigationBar)
    }
}

struct SectionHeading: View {
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(UniMateDesign.heading)
            if let subtitle {
                Text(subtitle).font(.subheadline).foregroundStyle(UniMateDesign.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct UniMateStatusView: View {
    let symbol: String
    let title: String
    let detail: String
    var loading = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if loading {
                ProgressView().tint(UniMateDesign.accent)
            } else {
                Image(systemName: symbol).foregroundStyle(UniMateDesign.accent)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(UniMateDesign.secondary)
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

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14)) : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
        layout {
            fact("NOW", value: now)
            fact("NEXT CLASS", value: next, detail: time)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let minutes { fact("FREE", value: "\(minutes) min") }
        }
        .padding(16)
        .background(Color.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 20))
        .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(UniMateDesign.line) }
    }

    private func fact(_ label: String, value: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption2.weight(.bold)).tracking(1).foregroundStyle(UniMateDesign.secondary)
            Text(value).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            if let detail { Text(detail).font(.caption).foregroundStyle(UniMateDesign.secondary) }
        }
        .accessibilityElement(children: .combine)
    }
}

struct RecordingStatus: View {
    @State private var startedAt = Date()

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "waveform").foregroundStyle(UniMateDesign.accent)
            Text("Listening").fontWeight(.semibold)
            Text(startedAt, style: .timer).monospacedDigit().fixedSize()
            Text("· release to send")
        }
        .font(.footnote)
        .foregroundStyle(UniMateDesign.secondary)
        .accessibilityElement(children: .combine)
    }
}
