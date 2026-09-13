import Foundation

/// Parsing and display helpers for the contract's date strings:
/// IsoDateTime "2026-09-14T17:00:00-07:00", IsoDate "2026-09-14", TimeOfDay "14:00".
/// Wall-clock values are displayed in the offset they carry, so the app shows the
/// same times as the API even if the phone's time zone differs.
enum DateFormatting {
    private static let posix = Locale(identifier: "en_US_POSIX")
    private static let displayLocale = Locale(identifier: "en_US")

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let isoFractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoOutputFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone.current
        return formatter
    }()

    private static let localNoOffsetFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = posix
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return formatter
    }()

    private static let localNoSecondsFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = posix
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return formatter
    }()

    private static let isoDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = posix
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let hhmmFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = posix
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = displayLocale
        formatter.dateFormat = "h:mm a"
        return formatter
    }()

    private static let dayTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = displayLocale
        formatter.dateFormat = "EEE h:mm a"
        return formatter
    }()

    private static let mediumDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = displayLocale
        formatter.dateFormat = "EEE, MMM d"
        return formatter
    }()

    // MARK: Parsing

    /// Parses an IsoDateTime. Falls back to strings without an offset (local time).
    static func parse(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        if let date = isoFormatter.date(from: string) { return date }
        if let date = isoFractionalFormatter.date(from: string) { return date }
        if let date = localNoOffsetFormatter.date(from: string) { return date }
        if let date = localNoSecondsFormatter.date(from: string) { return date }
        return isoDateFormatter.date(from: string)
    }

    /// The fixed-offset time zone carried by an IsoDateTime ("-07:00" or "Z"); current zone otherwise.
    static func timeZone(of string: String?) -> TimeZone {
        guard let string, string.count > 19 else { return TimeZone.current }
        if string.hasSuffix("Z") {
            return TimeZone(secondsFromGMT: 0) ?? TimeZone.current
        }
        let suffix = String(string.suffix(6))
        guard let sign = suffix.first, sign == "+" || sign == "-" else { return TimeZone.current }
        let parts = suffix.dropFirst().split(separator: ":")
        guard parts.count == 2, let hours = Int(parts[0]), let minutes = Int(parts[1]) else {
            return TimeZone.current
        }
        let magnitude = hours * 3600 + minutes * 60
        let seconds = sign == "-" ? -magnitude : magnitude
        return TimeZone(secondsFromGMT: seconds) ?? TimeZone.current
    }

    /// Parses an IsoDate "YYYY-MM-DD" as local midnight.
    static func parseIsoDate(_ string: String?) -> Date? {
        guard let string, string.count >= 10 else { return nil }
        return isoDateFormatter.date(from: String(string.prefix(10)))
    }

    /// Parses "HH:MM" into today's date at that local time.
    static func dateToday(fromHHMM string: String) -> Date? {
        let parts = string.split(separator: ":")
        guard parts.count >= 2, let hour = Int(parts[0]), let minute = Int(parts[1]) else { return nil }
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date())
    }

    // MARK: Output strings for requests

    /// Real wall-clock "now" as IsoDateTime with the device's offset.
    static func nowISO() -> String {
        isoOutputFormatter.string(from: Date())
    }

    static func isoDate(from date: Date) -> String {
        isoDateFormatter.string(from: date)
    }

    static func hhmm(from date: Date) -> String {
        hhmmFormatter.string(from: date)
    }

    // MARK: Display

    /// "2:00 PM"
    static func time(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        timeFormatter.timeZone = timeZone(of: iso)
        return timeFormatter.string(from: date)
    }

    /// "Tue 5:00 PM"
    static func dayTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        dayTimeFormatter.timeZone = timeZone(of: iso)
        return dayTimeFormatter.string(from: date)
    }

    /// "5:00 PM" when on the same day as `reference`, else "Tue 5:00 PM".
    static func smartTime(_ iso: String?, relativeTo reference: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let zone = timeZone(of: iso)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let referenceDate = parse(reference) ?? Date()
        if calendar.isDate(date, inSameDayAs: referenceDate) {
            return time(iso)
        }
        return dayTime(iso)
    }

    /// "Tue, Sep 18" from an IsoDate.
    static func mediumDate(_ isoDate: String?) -> String? {
        guard let date = parseIsoDate(isoDate) else { return nil }
        mediumDateFormatter.timeZone = TimeZone.current
        return mediumDateFormatter.string(from: date)
    }

    /// "in 3 h 47 min", "in 12 min", "2 h ago", "now"
    static func relative(from start: Date, to end: Date) -> String {
        let totalMinutes = Int((end.timeIntervalSince(start) / 60).rounded())
        if totalMinutes == 0 { return "now" }
        let magnitude = abs(totalMinutes)
        let hours = magnitude / 60
        let minutes = magnitude % 60
        let body: String
        if hours >= 48 {
            body = "\(hours / 24) days"
        } else if hours > 0 && minutes > 0 {
            body = "\(hours) h \(minutes) min"
        } else if hours > 0 {
            body = "\(hours) h"
        } else {
            body = "\(minutes) min"
        }
        return totalMinutes > 0 ? "in \(body)" : "\(body) ago"
    }

    /// "in 3 h 47 min" for an IsoDateTime relative to another IsoDateTime (or the real clock).
    static func relative(_ iso: String?, from reference: String?) -> String? {
        guard let date = parse(iso) else { return nil }
        let start = parse(reference) ?? Date()
        return relative(from: start, to: date)
    }

    /// "14:00" -> "2:00 PM"
    static func timeOfDay(_ hhmm: String) -> String {
        guard let parsed = parseHHMM(hhmm) else { return hhmm }
        let suffix = parsed.hour < 12 ? "AM" : "PM"
        return "\(twelveHour(parsed.hour)):\(twoDigits(parsed.minute)) \(suffix)"
    }

    /// "14:00", "17:00" -> "2:00–5:00 PM"; "11:30", "12:20" -> "11:30 AM–12:20 PM"
    static func timeRange(_ start: String, _ end: String) -> String {
        guard let startParts = parseHHMM(start), let endParts = parseHHMM(end) else {
            return "\(start)–\(end)"
        }
        let startSuffix = startParts.hour < 12 ? "AM" : "PM"
        let endSuffix = endParts.hour < 12 ? "AM" : "PM"
        let startText = "\(twelveHour(startParts.hour)):\(twoDigits(startParts.minute))"
        let endText = "\(twelveHour(endParts.hour)):\(twoDigits(endParts.minute)) \(endSuffix)"
        if startSuffix == endSuffix {
            return "\(startText)–\(endText)"
        }
        return "\(startText) \(startSuffix)–\(endText)"
    }

    /// ISO day of week (1 = Monday ... 7 = Sunday) -> "Monday"
    static func weekdayName(_ dayOfWeek: Int) -> String {
        let names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        guard dayOfWeek >= 1, dayOfWeek <= 7 else { return "Day \(dayOfWeek)" }
        return names[dayOfWeek - 1]
    }

    static func shortWeekdayName(_ dayOfWeek: Int) -> String {
        let names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        guard dayOfWeek >= 1, dayOfWeek <= 7 else { return "D\(dayOfWeek)" }
        return names[dayOfWeek - 1]
    }

    /// Today's ISO day of week on the device.
    static func todayISODayOfWeek() -> Int {
        let weekday = Calendar(identifier: .gregorian).component(.weekday, from: Date()) // 1 = Sunday
        return weekday == 1 ? 7 : weekday - 1
    }

    // MARK: Private

    private static func parseHHMM(_ string: String) -> (hour: Int, minute: Int)? {
        let parts = string.split(separator: ":")
        guard parts.count >= 2, let hour = Int(parts[0]), let minute = Int(parts[1]),
              hour >= 0, hour < 24, minute >= 0, minute < 60 else { return nil }
        return (hour, minute)
    }

    private static func twelveHour(_ hour: Int) -> Int {
        let value = hour % 12
        return value == 0 ? 12 : value
    }

    private static func twoDigits(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }
}

enum MoneyFormatting {
    /// 79 -> "$79", 21.5 -> "$21.50"
    static func dollars(_ amount: Double) -> String {
        if amount.rounded() == amount {
            return "$\(Int(amount))"
        }
        return String(format: "$%.2f", amount)
    }
}
