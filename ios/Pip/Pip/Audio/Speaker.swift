import AVFoundation
import Foundation

/// Thin AVSpeechSynthesizer wrapper. Reports speaking changes on the main actor.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()

    /// Called on the main actor whenever speech starts (true) or finishes/cancels (false).
    var onSpeakingChanged: (@MainActor (Bool) -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    var isSpeaking: Bool {
        synthesizer.isSpeaking
    }

    /// Speaks `text` unless muted (UserDefaults "pip_muted"). Returns whether speech started.
    @discardableResult
    func speak(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !Config.isMuted, !trimmed.isEmpty else { return false }

        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        prepareSessionForPlayback()

        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1.05
        synthesizer.speak(utterance)
        return true
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    private func prepareSessionForPlayback() {
        let session = AVAudioSession.sharedInstance()
        // After a recording the session is already playAndRecord + defaultToSpeaker; keep it.
        guard session.category != .playAndRecord else { return }
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
        } catch {
            // Speech still works with the default session; nothing to surface.
        }
    }

    // MARK: AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        notify(true)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        notify(false)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        notify(false)
    }

    private func notify(_ speaking: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // A cancel for an old utterance can arrive after a new one started.
            if !speaking && self.synthesizer.isSpeaking { return }
            self.onSpeakingChanged?(speaking)
        }
    }
}
