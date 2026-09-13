import AVFoundation
import Foundation

/// ElevenLabs audio playback with device speech fallback and cancellation.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var request: Task<Void, Never>?
    private var generation = UUID()

    /// Called on the main actor whenever speech starts (true) or finishes/cancels (false).
    var onSpeakingChanged: (@MainActor (Bool) -> Void)?
    var onWord: (@MainActor () -> Void)?

    static let speechRate: Float = AVSpeechUtteranceDefaultSpeechRate * 0.92
    static let pitch: Float = 1.0

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    var isSpeaking: Bool {
        synthesizer.isSpeaking || audioPlayer?.isPlaying == true || request != nil
    }

    /// Speaks `text` unless muted (UserDefaults "pip_muted"). Returns whether speech started.
    @discardableResult
    func speak(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !Config.isMuted, !trimmed.isEmpty else { return false }

        stop()
        let token = generation
        request = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                guard let base = Config.apiBaseURL else { throw URLError(.badURL) }
                var request = URLRequest(url: base.appendingPathComponent("speech"))
                request.httpMethod = "POST"
                request.timeoutInterval = 18
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONEncoder().encode(["text": trimmed])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard !Task.isCancelled, self.generation == token, !Config.isMuted else { return }
                guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                      http.mimeType == "audio/mpeg" else { throw URLError(.badServerResponse) }
                self.prepareSessionForPlayback()
                let player = try AVAudioPlayer(data: data)
                player.delegate = self
                self.audioPlayer = player
                guard player.play() else { throw URLError(.cannotDecodeContentData) }
                self.request = nil
                self.notify(true)
                self.notifyWord()
            } catch {
                guard !Task.isCancelled, self.generation == token, !Config.isMuted else { return }
                self.request = nil
                self.audioPlayer = nil
                self.speakOnDevice(trimmed)
            }
        }
        return true
    }

    private func speakOnDevice(_ text: String) {
        prepareSessionForPlayback()

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.preferredVoice
        utterance.rate = Self.speechRate
        utterance.pitchMultiplier = Self.pitch
        synthesizer.speak(utterance)
    }

    private static let preferredVoice: AVSpeechSynthesisVoice? = {
        let names = ["Ava", "Zoe", "Noelle", "Joelle", "Samantha", "Allison"]
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-US" }
        for quality in [AVSpeechSynthesisVoiceQuality.premium, .enhanced, .default] {
            let matches = voices.filter { $0.quality == quality }
            for name in names {
                if let voice = matches.first(where: { $0.name.hasPrefix(name) }) { return voice }
            }
        }
        return AVSpeechSynthesisVoice(language: "en-US")
    }()

    func stop() {
        generation = UUID()
        request?.cancel()
        request = nil
        audioPlayer?.stop()
        audioPlayer = nil
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        notify(false)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard player === audioPlayer else { return }
        audioPlayer = nil
        notify(false)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        guard player === audioPlayer else { return }
        audioPlayer = nil
        notify(false)
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
        notifyWord()
    }

    private func notifyWord() {
        Task { @MainActor [weak self] in self?.onWord?() }
    }

    private func notify(_ speaking: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // A cancel for an old utterance can arrive after a new one started.
            if !speaking && self.isSpeaking { return }
            self.onSpeakingChanged?(speaking)
        }
    }
}
