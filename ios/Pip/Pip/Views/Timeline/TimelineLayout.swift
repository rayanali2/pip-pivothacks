import CoreGraphics
import Foundation

/// Pure geometry for `DayTimelineView`. Turns a plan into rows measured in points below the Now line:
/// time runs at `pointsPerMinute`, an empty stretch longer than `collapseGapMinutes` becomes one short
/// "2 h 15 min free" row, and every card keeps a minimum height, pushing later rows down so none overlap.
/// Items without a clock time go to the tray instead.
struct TimelineLayout: Equatable {
    struct Metrics: Equatable {
        var pointsPerMinute: CGFloat = 1.1
        var collapseGapMinutes: Double = 75
        var gapRowHeight: CGFloat = 30
        var spacing: CGFloat = 8
        var doNowMinHeight: CGFloat = 80
        var cardMinHeight: CGFloat = 76
        var markerMinHeight: CGFloat = 52
        var minTickSpacing: CGFloat = 22
    }

    enum EntryStyle: Equatable {
        case doNow
        case fixedBlock
        case task
        /// the "#cont" session that finishes the do-now later
        case continuation
        /// a start with no end, e.g. bedtime
        case marker
    }

    struct Entry: Identifiable, Equatable {
        let item: PlanItem
        let style: EntryStyle
        /// "1:13–1:48 PM", "11:30 PM", or "Then · ~20 min" when the plan gave no clock time
        let timeText: String
        let y: CGFloat
        let height: CGFloat

        var id: String { item.itemId }
    }

    struct Tick: Identifiable, Equatable {
        let id: String
        /// "2 PM"
        let label: String
        /// vertical center of the label
        let y: CGFloat
    }

    struct Gap: Identifiable, Equatable {
        let id: String
        /// "2 h 15 min free"
        let label: String
        let y: CGFloat
        let height: CGFloat
    }

    enum Row: Identifiable, Equatable {
        case tick(Tick)
        case gap(Gap)
        case entry(Entry)

        var id: String {
            switch self {
            case .tick(let tick): return tick.id
            case .gap(let gap): return gap.id
            case .entry(let entry): return entry.id
            }
        }

        var y: CGFloat {
            switch self {
            case .tick(let tick): return tick.y
            case .gap(let gap): return gap.y
            case .entry(let entry): return entry.y
            }
        }

        /// Tie-break for rows at the same y: cards before hour labels.
        fileprivate var rank: Int {
            switch self {
            case .entry: return 0
            case .gap: return 1
            case .tick: return 2
            }
        }
    }

    enum TrayReason: Equatable {
        /// flagged at_risk: the first step needs more minutes than the plan has
        case atRisk(neededMinutes: Int?, availableMinutes: Int)
        /// no clock time and not at risk: the ranker found no open slot for it
        case needsGap(minutes: Int?)
    }

    struct TrayEntry: Identifiable, Equatable {
        let item: PlanItem
        let reason: TrayReason

        var id: String { item.itemId }
    }

    /// Scenario time of the Now line, "1:13 PM".
    let nowText: String
    /// In plan order: at_risk items first, as the ranker sorts them.
    let tray: [TrayEntry]
    /// Top to bottom.
    let rows: [Row]
    let height: CGFloat

    /// Mirrors SLOT_GAP_MINUTES in api/src/ranker/plan.ts.
    static let slotGapMinutes = 15

    private struct Slot {
        let item: PlanItem
        let style: EntryStyle
        let start: Date
        /// nil for markers
        let end: Date?
        let timeText: String
        /// plan order, to break ties between equal starts
        let order: Int
    }

    private struct Segment {
        let from: Date
        let to: Date
        let top: CGFloat
        let bottom: CGFloat

        func y(at date: Date) -> CGFloat {
            let span = to.timeIntervalSince(from)
            guard span > 0 else { return top }
            return top + (bottom - top) * CGFloat(date.timeIntervalSince(from) / span)
        }
    }

    // MARK: Builder

    static func make(plan: Plan, metrics: Metrics = Metrics()) -> TimelineLayout {
        let planNow = plan.reasoning.now
        let nowText = DateFormatting.time(planNow) ?? "Now"
        let origin = DateFormatting.parse(planNow)
        let items = sortItems(of: plan, origin: origin)
        guard let start = origin ?? items.slots.map(\.start).min() else {
            return TimelineLayout(nowText: nowText, tray: items.tray, rows: [], height: 0)
        }

        let ordered = items.slots.sorted { lhs, rhs in
            lhs.start == rhs.start ? lhs.order < rhs.order : lhs.start < rhs.start
        }
        let scale = metrics.pointsPerMinute
        var rows: [Row] = []
        var segments: [Segment] = []
        var cursorTime = start
        var cursorY: CGFloat = 0

        for slot in ordered {
            let slotStart = max(slot.start, start)
            let gapMinutes = slotStart.timeIntervalSince(cursorTime) / 60
            let y: CGFloat
            if gapMinutes > metrics.collapseGapMinutes {
                let gapY = rows.isEmpty ? 0 : cursorY + metrics.spacing
                rows.append(.gap(Gap(
                    id: "gap-\(Int(cursorTime.timeIntervalSince1970))",
                    label: "\(durationText(minutes: Int(gapMinutes.rounded()))) free",
                    y: gapY,
                    height: metrics.gapRowHeight
                )))
                y = gapY + metrics.gapRowHeight + metrics.spacing
            } else {
                let timeY = cursorY + CGFloat(max(0, gapMinutes)) * scale
                y = rows.isEmpty ? timeY : max(timeY, cursorY + metrics.spacing)
                if gapMinutes > 0 {
                    segments.append(Segment(from: cursorTime, to: slotStart, top: cursorY, bottom: y))
                }
            }

            let height: CGFloat
            if slot.style == .marker {
                height = metrics.markerMinHeight
            } else {
                let slotEnd = max(slot.end ?? slotStart, slotStart)
                let minutes = slotEnd.timeIntervalSince(slotStart) / 60
                height = max(minHeight(for: slot.style, metrics: metrics), CGFloat(minutes) * scale)
                if minutes > 0 {
                    segments.append(Segment(from: slotStart, to: slotEnd, top: y, bottom: y + height))
                }
            }

            rows.append(.entry(Entry(item: slot.item, style: slot.style, timeText: slot.timeText, y: y, height: height)))
            cursorY = max(cursorY, y + height)
            cursorTime = max(cursorTime, slot.end ?? slotStart)
        }

        let end = ordered.map { $0.end ?? $0.start }.max() ?? start
        let ticks = hourTicks(
            from: start,
            to: end,
            segments: segments,
            zone: DateFormatting.timeZone(of: planNow),
            metrics: metrics
        )
        let allRows = (rows + ticks).sorted { lhs, rhs in
            lhs.y == rhs.y ? lhs.rank < rhs.rank : lhs.y < rhs.y
        }
        return TimelineLayout(nowText: nowText, tray: items.tray, rows: allRows, height: cursorY)
    }

    /// Timed items become slots; at_risk and unslotted items go to the tray. Each item_id appears once.
    private static func sortItems(of plan: Plan, origin: Date?) -> (slots: [Slot], tray: [TrayEntry]) {
        let planNow = plan.reasoning.now
        var slots: [Slot] = []
        var tray: [TrayEntry] = []
        var seen = Set<String>()
        var doNowEnd: Date?

        if let doNow = plan.doNow, let start = DateFormatting.parse(doNow.startsAt) ?? origin {
            seen.insert(doNow.itemId)
            let minutes = firstStepMinutes(for: doNow, in: plan) ?? 15
            let end = laterDate(DateFormatting.parse(doNow.endsAt), than: start)
                ?? start.addingTimeInterval(TimeInterval(minutes * 60))
            let clock = DateFormatting.smartTime(doNow.startsAt, relativeTo: planNow) ?? "Now"
            let text = rangeText(doNow.startsAt, doNow.endsAt, planNow: planNow) ?? "\(clock) · ~\(minutes) min"
            slots.append(Slot(item: doNow, style: .doNow, start: start, end: end, timeText: text, order: 0))
            doNowEnd = end
        }

        var others: [PlanItem] = []
        if let next = plan.next {
            others.append(next)
        }
        others.append(contentsOf: plan.today)

        for (index, item) in others.enumerated() {
            guard seen.insert(item.itemId).inserted else { continue }
            let order = index + 1
            if let start = DateFormatting.parse(item.startsAt) {
                if let end = laterDate(DateFormatting.parse(item.endsAt), than: start) {
                    let clock = DateFormatting.smartTime(item.startsAt, relativeTo: planNow) ?? ""
                    let text = rangeText(item.startsAt, item.endsAt, planNow: planNow) ?? clock
                    slots.append(Slot(item: item, style: style(for: item), start: start, end: end, timeText: text, order: order))
                } else {
                    let text = DateFormatting.smartTime(item.startsAt, relativeTo: planNow) ?? ""
                    slots.append(Slot(item: item, style: .marker, start: start, end: nil, timeText: text, order: order))
                }
            } else if item.flag == .atRisk {
                let reason = TrayReason.atRisk(
                    neededMinutes: firstStepMinutes(for: item, in: plan),
                    availableMinutes: plan.reasoning.effectiveMinutes
                )
                tray.append(TrayEntry(item: item, reason: reason))
            } else if item.itemId == plan.next?.itemId, item.kind != .fixedBlock, let anchor = doNowEnd ?? origin {
                // A next task without a clock time: the ranker books it one slot gap after do now.
                let minutes = firstStepMinutes(for: item, in: plan) ?? 15
                let start = doNowEnd == nil ? anchor : anchor.addingTimeInterval(TimeInterval(slotGapMinutes * 60))
                let end = start.addingTimeInterval(TimeInterval(minutes * 60))
                slots.append(Slot(item: item, style: .task, start: start, end: end, timeText: "Then · ~\(minutes) min", order: order))
            } else {
                let minutes = item.estMinutes ?? firstStepMinutes(for: item, in: plan)
                tray.append(TrayEntry(item: item, reason: .needsGap(minutes: minutes)))
            }
        }
        return (slots, tray)
    }

    private static func hourTicks(from start: Date, to end: Date, segments: [Segment], zone: TimeZone, metrics: Metrics) -> [Row] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        guard var hour = calendar.nextDate(after: start, matching: DateComponents(minute: 0, second: 0), matchingPolicy: .nextTime) else {
            return []
        }
        var ticks: [Row] = []
        var lastY: CGFloat?
        var steps = 0
        while hour <= end && steps < 96 {
            steps += 1
            // Hours inside a collapsed gap have no segment and get no label.
            if let segment = segments.first(where: { $0.from <= hour && hour <= $0.to }) {
                let y = segment.y(at: hour)
                let clearOfNow = y >= metrics.minTickSpacing / 2
                let clearOfLast = lastY.map { y - $0 >= metrics.minTickSpacing } ?? true
                if clearOfNow && clearOfLast {
                    let label = hourLabel(calendar.component(.hour, from: hour))
                    ticks.append(.tick(Tick(id: "tick-\(Int(hour.timeIntervalSince1970))", label: label, y: y)))
                    lastY = y
                }
            }
            hour = hour.addingTimeInterval(3600)
        }
        return ticks
    }

    // MARK: Helpers

    /// The first-step minutes the ranker used: its pre-rank entry, else the number in the
    /// fits_window evidence ("First step is 35 min ..."), else the item's estimate.
    static func firstStepMinutes(for item: PlanItem, in plan: Plan) -> Int? {
        if let taskID = item.taskId,
           let entry = plan.reasoning.preRank.first(where: { $0.taskId == taskID }),
           entry.firstStepMinutes > 0 {
            return entry.firstStepMinutes
        }
        if let detail = item.evidence.first(where: { $0.rule == .fitsWindow })?.detail,
           let minutes = firstInteger(in: detail), minutes > 0 {
            return minutes
        }
        return item.estMinutes
    }

    /// "1:13–1:48 PM" for a slot on the plan's day, "Tue 5:15–6:45 PM" otherwise; nil without both times.
    /// Built from the wall clock each string carries, like every other time in the app.
    static func rangeText(_ startISO: String?, _ endISO: String?, planNow: String) -> String? {
        guard let startISO, let endISO,
              let startText = DateFormatting.smartTime(startISO, relativeTo: planNow),
              let endText = DateFormatting.time(endISO) else { return nil }
        if let start = wallClock(startISO), let end = wallClock(endISO) {
            let range = DateFormatting.timeRange(start, end)
            if startText == DateFormatting.time(startISO) {
                return range
            }
            // smartTime put the weekday first because the slot is on another day.
            if let day = startText.split(separator: " ").first {
                return "\(day) \(range)"
            }
        }
        return "\(startText)–\(endText)"
    }

    /// 135 -> "2 h 15 min", 120 -> "2 h", 50 -> "50 min"
    static func durationText(minutes: Int) -> String {
        let hours = minutes / 60
        let rest = minutes % 60
        if hours > 0 && rest > 0 {
            return "\(hours) h \(rest) min"
        }
        if hours > 0 {
            return "\(hours) h"
        }
        return "\(minutes) min"
    }

    private static func style(for item: PlanItem) -> EntryStyle {
        if item.kind == .fixedBlock {
            return .fixedBlock
        }
        if item.itemId.hasSuffix("#cont") {
            return .continuation
        }
        return .task
    }

    private static func minHeight(for style: EntryStyle, metrics: Metrics) -> CGFloat {
        switch style {
        case .doNow: return metrics.doNowMinHeight
        case .marker: return metrics.markerMinHeight
        case .fixedBlock, .task, .continuation: return metrics.cardMinHeight
        }
    }

    /// `date` when it is after `start`, else nil.
    private static func laterDate(_ date: Date?, than start: Date) -> Date? {
        guard let date, date > start else { return nil }
        return date
    }

    /// "13:13" from "2026-09-14T13:13:00-07:00".
    private static func wallClock(_ iso: String) -> String? {
        let characters = Array(iso)
        guard characters.count >= 16, characters[10] == "T" else { return nil }
        return String(characters[11..<16])
    }

    /// 14 -> "2 PM", through the same helper as the rows' times.
    private static func hourLabel(_ hour: Int) -> String {
        let hhmm = hour < 10 ? "0\(hour):00" : "\(hour):00"
        return DateFormatting.timeOfDay(hhmm).replacingOccurrences(of: ":00", with: "")
    }

    private static func firstInteger(in text: String) -> Int? {
        var digits = ""
        for character in text {
            if character.isASCII && character.isNumber {
                digits.append(character)
            } else if !digits.isEmpty {
                break
            }
        }
        return Int(digits)
    }
}
