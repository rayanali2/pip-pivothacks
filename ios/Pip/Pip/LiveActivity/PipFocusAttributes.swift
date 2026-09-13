import ActivityKit
import Foundation

/// Live Activity payload for a focus session.
/// Keep in sync with UniMateWidgets/UniMateFocusAttributes.swift: ActivityKit matches the app's and the
/// widget extension's copies by type name, so both must declare exactly the same fields.
struct UniMateFocusAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// When the focus block ends, including any extensions.
        var endsAt: Date
        /// running | overtime | done
        var phase: String
        var extendedMinutes: Int
    }

    var title: String
    var nextLabel: String?
    var moneyAtRisk: Double?
}
