import Foundation

/// Normal use always talks to the API, including retries after a connection failure.
/// Bundled fixtures are available only with the explicit debug demo launch argument.
@MainActor
final class ServiceRouter {
    static let healthTimeout: TimeInterval = 4

    let offline = OfflineService()
    private(set) var remote: RemoteService?
    private(set) var isOffline = true

    init() {
        if let url = Config.apiBaseURL {
            remote = RemoteService(baseURL: url)
        }
    }

    /// Re-reads the base URL from Config and drops back to offline until `connect()` succeeds.
    func reloadBaseURL() {
        if let url = Config.apiBaseURL {
            remote = RemoteService(baseURL: url)
        } else {
            remote = nil
        }
        isOffline = true
    }

    /// Returns the health response from whichever backend ends up active.
    @discardableResult
    func connect() async -> HealthResponse? {
        if let remote {
            do {
                let health = try await remote.health(timeout: Self.healthTimeout)
                isOffline = false
                return health
            } catch {
                isOffline = true
            }
        } else {
            isOffline = true
        }
        if Config.isDemoMode { return try? await offline.health() }
        return nil
    }

    func run<T>(_ operation: (any UniMateService) async throws -> T) async throws -> T {
        if !Config.isDemoMode {
            guard let remote else { throw UniMateError.badURL }
            do {
                let result = try await operation(remote)
                isOffline = false
                return result
            } catch is URLError {
                isOffline = true
                throw UniMateError.serverUnavailable
            }
        }
        if !isOffline, let remote {
            do {
                return try await operation(remote)
            } catch is URLError {
                isOffline = true
                return try await operation(offline)
            }
        }
        return try await operation(offline)
    }
}
