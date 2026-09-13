import AVFoundation
import Foundation

enum RecorderError: LocalizedError {
    case couldNotStart

    var errorDescription: String? {
        switch self {
        case .couldNotStart: return "Couldn't start the microphone. Try typing instead."
        }
    }
}

/// Records mono AAC (.m4a, 44.1 kHz) to a temporary file for POST /captures/voice.
@MainActor
final class Recorder {
    /// Presses shorter than this are treated as accidental taps and discarded.
    static let minimumDuration: TimeInterval = 0.35

    private var recorder: AVAudioRecorder?
    private var startedAt: Date?

    var isRecording: Bool {
        recorder?.isRecording ?? false
    }

    enum Permission {
        case undetermined
        case denied
        case granted
    }

    var permission: Permission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        case .undetermined: return .undetermined
        @unknown default: return .undetermined
        }
    }

    func requestPermission() async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission(completionHandler: { granted in
                continuation.resume(returning: granted)
            })
        }
    }

    func start() throws {
        discard()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("capture-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100.0,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]

        let newRecorder = try AVAudioRecorder(url: url, settings: settings)
        newRecorder.prepareToRecord()
        guard newRecorder.record() else {
            throw RecorderError.couldNotStart
        }
        recorder = newRecorder
        startedAt = Date()
    }

    /// Stops recording. Returns the file URL, or nil if nothing was recording or the press was too short.
    func stop() -> URL? {
        guard let activeRecorder = recorder else { return nil }
        let duration = Date().timeIntervalSince(startedAt ?? Date())
        activeRecorder.stop()
        recorder = nil
        startedAt = nil

        if duration < Self.minimumDuration {
            activeRecorder.deleteRecording()
            return nil
        }
        return activeRecorder.url
    }

    /// Stops and deletes any in-progress recording.
    func discard() {
        guard let activeRecorder = recorder else { return }
        activeRecorder.stop()
        activeRecorder.deleteRecording()
        recorder = nil
        startedAt = nil
    }
}
