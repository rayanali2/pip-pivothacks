import Foundation

/// Google Calendar's review-and-save screen. UTC timestamps preserve the selected
/// instants across time zones and daylight-saving transitions.
enum GoogleCalendarLink {
    static func make(title: String, start: Date, end: Date, location: String) -> URL? {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, end > start else { return nil }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.calendar = Calendar(identifier: .gregorian)
        format.timeZone = TimeZone(secondsFromGMT: 0)
        format.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        var url = URLComponents(string: "https://calendar.google.com/calendar/render")
        url?.queryItems = [
            URLQueryItem(name: "action", value: "TEMPLATE"),
            URLQueryItem(name: "text", value: name),
            URLQueryItem(name: "dates", value: "\(format.string(from: start))/\(format.string(from: end))"),
            URLQueryItem(name: "location", value: location),
            URLQueryItem(name: "details", value: "Added from UniMate.")
        ]
        // '+' must be encoded because web query parsers can interpret it as a space.
        let encodedQuery = url?.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        url?.percentEncodedQuery = encodedQuery
        return url?.url
    }
}
