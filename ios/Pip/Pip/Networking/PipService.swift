import Foundation

enum PipError: LocalizedError {
    case badURL
    case invalidResponse
    case http(Int)
    case server(String)
    case missingFixture(String)
    case noPlan
    case previewNeedsServer

    var errorDescription: String? {
        switch self {
        case .badURL: return "The server address isn't a valid URL."
        case .invalidResponse: return "The server sent an unexpected response."
        case .http(let code): return "The server returned HTTP \(code)."
        case .server(let message): return message
        case .missingFixture(let name): return "Offline data \(name).json is missing from the app."
        case .noPlan: return "Tell Pip about your day first."
        case .previewNeedsServer: return "Previews need the Pip server."
        }
    }
}

/// Everything the app asks of the Pip API. RemoteService talks HTTP;
/// OfflineService serves bundled fixtures when the API is unreachable.
@MainActor
protocol PipService: AnyObject {
    var isOffline: Bool { get }
    func health() async throws -> HealthResponse
    /// clientTranscript: the on-device speech result, sent as client_transcript when non-empty.
    func captureVoice(fileURL: URL, followupPlanID: String?, clientTranscript: String?) async throws -> CaptureResponse
    func captureText(_ text: String, followupPlanID: String?) async throws -> CaptureResponse
    /// preview: compute the plan and diff without saving anything (plan_id "preview-…").
    func rerank(planID: String, context: RerankContextInput, preview: Bool) async throws -> RerankResponse
    func timetableToday() async throws -> TodayTimetableResponse
    func timetable() async throws -> TimetableResponse
    func putTimetable(blocks: [TimetableBlockInput]) async throws -> TimetableResponse
    func profile() async throws -> ProfileResponse
    func putProfile(_ request: PutProfileRequest) async throws -> ProfileResponse
    func recordAction(planID: String, taskID: String?, kind: ActionKind) async throws -> ActionResponse
    func history() async throws -> HistoryResponse
    func pivotLog() async throws -> PivotLogResponse
    func resetDemo() async throws -> DemoResetResponse
    func contextPlan(requestID: String, statedMinutes: Int?) async throws -> ContextPlanResponse
    func contextAction(requestID: String, planRequestID: String) async throws -> ContextActionResponse
    func contextHistory() async throws -> ContextHistoryResponse
    func contextPreview(planRequestID: String, overrun: ContextOverrunInput) async throws -> ContextPreviewResponse
}

@MainActor
final class RemoteService: PipService {
    /// Cortex transcription and planning can take a while.
    static let longTimeout: TimeInterval = 60
    static let shortTimeout: TimeInterval = 10

    let baseURL: URL
    let isOffline = false

    private let session: URLSession
    private let decoder = PipCoding.makeDecoder()
    private let encoder = PipCoding.makeEncoder()

    init(baseURL: URL) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = RemoteService.longTimeout
        configuration.timeoutIntervalForResource = 120
        configuration.waitsForConnectivity = false
        self.session = URLSession(configuration: configuration)
    }

    // MARK: PipService

    func health() async throws -> HealthResponse {
        try await health(timeout: Self.shortTimeout)
    }

    func health(timeout: TimeInterval) async throws -> HealthResponse {
        let request = try makeRequest("GET", "/health", timeout: timeout)
        return try await send(request, as: HealthResponse.self)
    }

    func captureVoice(fileURL: URL, followupPlanID: String?, clientTranscript: String?) async throws -> CaptureResponse {
        let audio = try Data(contentsOf: fileURL)
        let boundary = "PipBoundary-\(UUID().uuidString)"
        var body = Data()
        body.appendMultipartField(name: "student_id", value: Config.studentID, boundary: boundary)
        if let followupPlanID {
            body.appendMultipartField(name: "followup_plan_id", value: followupPlanID, boundary: boundary)
        }
        if let clientTranscript = clientTranscript?.trimmingCharacters(in: .whitespacesAndNewlines),
           !clientTranscript.isEmpty {
            body.appendMultipartField(name: "client_transcript", value: clientTranscript, boundary: boundary)
        }
        body.appendMultipartFile(
            name: "audio",
            filename: "capture.m4a",
            contentType: "audio/m4a",
            data: audio,
            boundary: boundary
        )
        body.appendUTF8("--\(boundary)--\r\n")

        var request = try makeRequest("POST", "/captures/voice", timeout: Self.longTimeout)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return try await send(request, as: CaptureResponse.self)
    }

    func captureText(_ text: String, followupPlanID: String?) async throws -> CaptureResponse {
        let payload = CaptureTextRequest(studentId: Config.studentID, text: text, followupPlanId: followupPlanID)
        let request = try makeJSONRequest("POST", "/captures/text", body: payload, timeout: Self.longTimeout)
        return try await send(request, as: CaptureResponse.self)
    }

    func rerank(planID: String, context: RerankContextInput, preview: Bool) async throws -> RerankResponse {
        let payload = RerankRequest(
            studentId: Config.studentID,
            planId: planID,
            context: context,
            preview: preview ? true : nil
        )
        let request = try makeJSONRequest("POST", "/plans/rerank", body: payload, timeout: Self.longTimeout)
        return try await send(request, as: RerankResponse.self)
    }

    func timetableToday() async throws -> TodayTimetableResponse {
        let request = try makeRequest("GET", "/timetable/today", query: studentQuery, timeout: Self.shortTimeout)
        return try await send(request, as: TodayTimetableResponse.self)
    }

    func timetable() async throws -> TimetableResponse {
        let request = try makeRequest("GET", "/timetable", query: studentQuery, timeout: Self.shortTimeout)
        return try await send(request, as: TimetableResponse.self)
    }

    func putTimetable(blocks: [TimetableBlockInput]) async throws -> TimetableResponse {
        let payload = PutTimetableRequest(studentId: Config.studentID, blocks: blocks)
        let request = try makeJSONRequest("PUT", "/timetable", body: payload, timeout: Self.shortTimeout)
        return try await send(request, as: TimetableResponse.self)
    }

    func profile() async throws -> ProfileResponse {
        let request = try makeRequest("GET", "/profile", query: studentQuery, timeout: Self.shortTimeout)
        return try await send(request, as: ProfileResponse.self)
    }

    func putProfile(_ payload: PutProfileRequest) async throws -> ProfileResponse {
        let request = try makeJSONRequest("PUT", "/profile", body: payload, timeout: Self.shortTimeout)
        return try await send(request, as: ProfileResponse.self)
    }

    func recordAction(planID: String, taskID: String?, kind: ActionKind) async throws -> ActionResponse {
        let payload = ActionRequest(studentId: Config.studentID, planId: planID, taskId: taskID, kind: kind)
        let request = try makeJSONRequest("POST", "/actions", body: payload, timeout: Self.shortTimeout)
        return try await send(request, as: ActionResponse.self)
    }

    func history() async throws -> HistoryResponse {
        let request = try makeRequest("GET", "/history", query: studentQuery, timeout: Self.shortTimeout)
        return try await send(request, as: HistoryResponse.self)
    }

    func pivotLog() async throws -> PivotLogResponse {
        let request = try makeRequest("GET", "/pivot-log", timeout: Self.shortTimeout)
        return try await send(request, as: PivotLogResponse.self)
    }

    func resetDemo() async throws -> DemoResetResponse {
        let payload = DemoResetRequest(studentId: Config.studentID)
        let request = try makeJSONRequest("POST", "/demo/reset", body: payload, timeout: Self.shortTimeout)
        return try await send(request, as: DemoResetResponse.self)
    }

    func contextPlan(requestID: String, statedMinutes: Int?) async throws -> ContextPlanResponse {
        let payload = ContextPlanRequest(requestId: requestID, statedMinutes: statedMinutes)
        let request = try makeJSONRequest("POST", "/context/plan", body: payload, timeout: Self.shortTimeout)
        return try await send(request, as: ContextPlanResponse.self)
    }

    func contextAction(requestID: String, planRequestID: String) async throws -> ContextActionResponse {
        let payload = ContextActionRequest(requestId: requestID, planRequestId: planRequestID, kind: "start_now")
        let request = try makeJSONRequest("POST", "/context/actions", body: payload, timeout: Self.shortTimeout)
        return try await send(request, as: ContextActionResponse.self)
    }

    func contextHistory() async throws -> ContextHistoryResponse {
        let request = try makeRequest("GET", "/context/history", timeout: Self.shortTimeout)
        return try await send(request, as: ContextHistoryResponse.self)
    }

    func contextPreview(planRequestID: String, overrun: ContextOverrunInput) async throws -> ContextPreviewResponse {
        let payload = ContextPreviewRequest(planRequestId: planRequestID, overrun: overrun)
        let request = try makeJSONRequest("POST", "/context/preview", body: payload, timeout: Self.shortTimeout)
        return try await send(request, as: ContextPreviewResponse.self)
    }

    // MARK: Plumbing

    private var studentQuery: [URLQueryItem] {
        [URLQueryItem(name: "student_id", value: Config.studentID)]
    }

    private func makeURL(_ path: String, query: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw PipError.badURL
        }
        var basePath = components.path
        while basePath.hasSuffix("/") {
            basePath.removeLast()
        }
        components.path = basePath + path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw PipError.badURL }
        return url
    }

    private func makeRequest(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        timeout: TimeInterval
    ) throws -> URLRequest {
        let url = try makeURL(path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func makeJSONRequest<Body: Encodable>(
        _ method: String,
        _ path: String,
        body: Body,
        timeout: TimeInterval
    ) throws -> URLRequest {
        var request = try makeRequest(method, path, timeout: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PipError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            if let body = try? decoder.decode(ErrorResponse.self, from: data) {
                throw PipError.server(body.error)
            }
            throw PipError.http(http.statusCode)
        }
        return try decoder.decode(type, from: data)
    }
}

private extension Data {
    mutating func appendUTF8(_ string: String) {
        append(Data(string.utf8))
    }

    mutating func appendMultipartField(name: String, value: String, boundary: String) {
        appendUTF8("--\(boundary)\r\n")
        appendUTF8("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        appendUTF8("\(value)\r\n")
    }

    mutating func appendMultipartFile(name: String, filename: String, contentType: String, data: Data, boundary: String) {
        appendUTF8("--\(boundary)\r\n")
        appendUTF8("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n")
        appendUTF8("Content-Type: \(contentType)\r\n\r\n")
        append(data)
        appendUTF8("\r\n")
    }
}
