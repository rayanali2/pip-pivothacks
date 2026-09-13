// Port of ios/Pip/Pip/Audio/Speaker.swift on the Web Speech API.
// Reports speaking changes and each spoken word, so the penguin's beak moves while Pip talks.

const NATURAL_NAMES = ['Ava', 'Zoe', 'Evan', 'Nathan', 'Noelle', 'Samantha', 'Allison', 'Susan', 'Tom', 'Aaron', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny'];

export class Speaker {
  constructor() {
    this.onSpeakingChanged = () => {};
    this.onWord = () => {};
    this.current = null;
    this.voice = null;
    if ('speechSynthesis' in window) {
      this.pickVoice();
      speechSynthesis.addEventListener('voiceschanged', () => this.pickVoice());
    }
  }

  get available() { return 'speechSynthesis' in window; }

  pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang === 'en-US' || v.lang === 'en_US');
    for (const name of NATURAL_NAMES) {
      const match = voices.find((v) => v.name.startsWith(name));
      if (match) { this.voice = match; return; }
    }
    this.voice = voices[0] || null;
  }

  /** Returns whether speech started. */
  speak(text) {
    const trimmed = String(text || '').trim();
    if (!this.available || !trimmed) return false;
    this.stop();
    const utterance = new SpeechSynthesisUtterance(trimmed);
    if (this.voice) utterance.voice = this.voice;
    utterance.lang = 'en-US';
    utterance.rate = 0.95;
    utterance.onstart = () => { if (this.current === utterance) this.onSpeakingChanged(true); };
    utterance.onboundary = (event) => { if (this.current === utterance && event.name !== 'sentence') this.onWord(); };
    const finish = () => {
      if (this.current !== utterance) return;
      this.current = null;
      this.onSpeakingChanged(false);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    this.current = utterance;
    speechSynthesis.speak(utterance);
    return true;
  }

  stop() {
    if (!this.available) return;
    const had = this.current;
    this.current = null;
    speechSynthesis.cancel();
    if (had) this.onSpeakingChanged(false);
  }
}
