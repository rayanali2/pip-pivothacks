import AVFoundation
import Foundation

/// Thin AVSpeechSynthesizer wrapper. Reports speaking changes and spoken words on the main actor.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()

    /// A touch slower than the system default, which sounds rushed for a plan read aloud.
    static let speechRate: Float = AVSpeechUtteranceDefaultSpeechRate * 0.92
    static let pitch: Float = 1.0

    /// Called on the main actor whenever speech starts (true) or finishes/cancels (false).
    var onSpeakingChanged: (@MainActor (Bool) -> Void)?

    /// Called on the main actor as each word is about to be spoken.
    var onWord: (@MainActor () -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    var isSpeaking: Bool {
        synthesizer.isSpeaking
    }

    /// Name of the voice Pip speaks with, e.g. "Ava (Premium)".
    static var activeVoiceName: String {
        preferredVoice?.name ?? "System voice"
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
        utterance.voice = Self.preferredVoice
        utterance.rate = Self.speechRate
        utterance.pitchMultiplier = Self.pitch
        synthesizer.speak(utterance)
        return true
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    // MARK: Voice

    /// Chosen once: the best installed en-US voice.
    private static let preferredVoice: AVSpeechSynthesisVoice? = bestVoice()

    /// Natural-sounding voices first, when several share the best quality.
    private static let naturalVoiceNames = [
        "Ava", "Zoe", "Evan", "Nathan", "Noelle", "Joelle", "Samantha", "Allison", "Susan", "Tom", "Nicky", "Aaron"
    ]

    /// Premium, then enhanced, then default quality. Novelty and Eloquence voices never qualify.
    private static func bestVoice() -> AVSpeechSynthesisVoice? {
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { voice in
            let identifier = voice.identifier.lowercased()
            return voice.language == "en-US"
                && !identifier.contains("eloquence")
                && !identifier.contains("speech.synthesis.voice")
        }
        let qualities: [AVSpeechSynthesisVoiceQuality] = [.premium, .enhanced, .default]
        for quality in qualities {
            let matches = candidates.filter { $0.quality == quality }
            guard !matches.isEmpty else { continue }
            for name in naturalVoiceNames {
                if let voice = matches.first(where: { $0.name.hasPrefix(name) }) {
                    return voice
                }
            }
            if let voice = matches.sorted(by: { $0.name < $1.name }).first {
                return voice
            }
        }
        return AVSpeechSynthesisVoice(language: "en-US")
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

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in
            self?.onWord?()
        }
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
