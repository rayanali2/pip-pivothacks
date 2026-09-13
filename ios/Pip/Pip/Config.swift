import Foundation

enum Config {
    /// Simulator default. On a physical device set this (or the Schedule > Server field)
    /// to http://<laptop LAN IP>:3000, e.g. http://192.168.1.20:3000
    static let defaultAPIBaseURL = "http://localhost:3000"

    /// The demo student. Every request sends this id.
    static let studentID = "demo"

    static let apiBaseURLKey = "api_base_url"
    static let mutedKey = "pip_muted"

    /// UserDefaults override "api_base_url" if set, else the default.
    static var apiBaseURLString: String {
        let stored = UserDefaults.standard.string(forKey: apiBaseURLKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return stored.isEmpty ? defaultAPIBaseURL : stored
    }

    /// Parsed base URL, or nil when the stored string is not a valid http(s) URL.
    static var apiBaseURL: URL? {
        makeURL(from: apiBaseURLString)
    }

    static func makeURL(from string: String) -> URL? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              components.host != nil,
              let url = components.url
        else { return nil }
        return url
    }

    static func setAPIBaseURL(_ string: String) {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == defaultAPIBaseURL {
            UserDefaults.standard.removeObject(forKey: apiBaseURLKey)
        } else {
            UserDefaults.standard.set(trimmed, forKey: apiBaseURLKey)
        }
    }

    static var isMuted: Bool {
        get { UserDefaults.standard.bool(forKey: mutedKey) }
        set { UserDefaults.standard.set(newValue, forKey: mutedKey) }
    }
}
