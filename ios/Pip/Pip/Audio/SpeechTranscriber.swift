import Foundation
import Speech

/// Transcribes a finished recording with Apple's Speech framework (on-device when the phone
/// supports it). The result is sent as client_transcript next to the audio. It never blocks a
/// capture: any failure, timeout or missing permission returns nil and the server works from
/// the audio alone.
enum SpeechTranscriber {
    private static let locale = Locale(identifier: "en-US")

    /// Asking for speech permission without this Info.plist key terminates the app.
    private static var hasUsageDescription: Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
    }

    static var isAuthorized: Bool {
        hasUsageDescription && SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    /// Returns immediately when the user has already answered.
    static func requestAuthorization() async -> Bool {
        guard hasUsageDescription else { return false }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .denied, .restricted: return false
        case .notDetermined: break
        @unknown default: return false
        }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    static func transcribe(fileURL: URL, timeout: TimeInterval) async -> String? {
        guard isAuthorized,
              let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.isAvailable
        else { return nil }

        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let box = RecognitionBox(recognizer: recognizer)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
                box.install(continuation)
                let task = recognizer.recognitionTask(with: request) { result, error in
                    if let result, result.isFinal {
                        let text = result.bestTranscription.formattedString
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        box.finish(text.isEmpty ? nil : text)
                    } else if error != nil {
                        box.finish(nil)
                    }
                }
                box.attach(task)
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
                    box.finish(nil)
                }
            }
        } onCancel: {
            box.finish(nil)
        }
    }
}

/// Resumes the continuation exactly once, whichever of result, error, timeout or cancellation
/// comes first, and cancels the recognition task when it didn't finish on its own.
private final class RecognitionBox: @unchecked Sendable {
    private let lock = NSLock()
    /// Kept alive for the whole recognition; a released recognizer stops its task.
    private var recognizer: SFSpeechRecognizer?
    private var continuation: CheckedContinuation<String?, Never>?
    private var task: SFSpeechRecognitionTask?
    private var isFinished = false

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
    }

    func install(_ continuation: CheckedContinuation<String?, Never>) {
        lock.lock()
        if isFinished {
            lock.unlock()
            continuation.resume(returning: nil)
            return
        }
        self.continuation = continuation
        lock.unlock()
    }

    func attach(_ task: SFSpeechRecognitionTask) {
        lock.lock()
        if isFinished {
            lock.unlock()
            task.cancel()
            return
        }
        self.task = task
        lock.unlock()
    }

    func finish(_ text: String?) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }
        isFinished = true
        let pending = continuation
        let activeTask = task
        continuation = nil
        task = nil
        recognizer = nil
        lock.unlock()

        if text == nil {
            activeTask?.cancel()
        }
        pending?.resume(returning: text)
    }
}
