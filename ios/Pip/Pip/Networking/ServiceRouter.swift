import Foundation

/// Chooses between the live API and the bundled offline fixtures.
/// At launch it pings GET /health with a 4 s timeout: success -> remote, failure -> offline.
/// If a remote call fails with a transport error mid-session, that call is retried once
/// offline and the router stays offline. The only visible difference is the source label.
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
        return try? await offline.health()
    }

    func run<T>(_ operation: (any PipService) async throws -> T) async throws -> T {
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
