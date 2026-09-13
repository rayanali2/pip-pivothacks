import Foundation

extension Plan {
    /// "25 of 47 min free until CHEM 110 Lab, 2:00 PM" when the student gave fewer minutes,
    /// otherwise the free window's own label.
    var freeWindowText: String? {
        guard let window = reasoning.freeWindow else { return nil }
        if let available = reasoning.context.availableMinutes, available < window.minutes {
            if let title = window.nextBlockTitle, let time = DateFormatting.time(window.nextBlockStartsAt) {
                return "\(available) of \(window.minutes) min free until \(title), \(time)"
            }
            return "\(available) of \(window.minutes) min free"
        }
        return window.label
    }
}

extension PlanItem {
    /// Tasks open a detail screen; fixed blocks don't.
    var opensDetail: Bool {
        kind != .fixedBlock && taskId != nil
    }

    /// Left-column text: start time if scheduled, else "Due …", else nil.
    func timeLabel(relativeTo now: String?) -> String? {
        if let start = DateFormatting.smartTime(startsAt, relativeTo: now) {
            return start
        }
        if let due = DateFormatting.smartTime(dueAt, relativeTo: now) {
            return "Due \(due)"
        }
        return nil
    }
}

extension TimetableBlock {
    /// "CHEM 110 Lab · 2:00–5:00 PM · Science Hall 204"
    var summaryLine: String {
        var parts = [title, DateFormatting.timeRange(startsAt, endsAt)]
        if let location, !location.isEmpty {
            parts.append(location)
        }
        return parts.joined(separator: " · ")
    }
}
