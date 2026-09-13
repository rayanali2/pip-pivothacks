// Port of ios/Pip/Pip/Audio/Speaker.swift: ElevenLabs audio from the API's POST /speech, with Chrome's
// own voices as the fallback. Reports speaking changes and word-like pulses so the penguin's beak moves.

import { config } from './api.js';

const NATURAL_NAMES = ['Ava', 'Zoe', 'Noelle', 'Joelle', 'Samantha', 'Allison', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny'];
const REQUEST_TIMEOUT_MS = 18000;

export class Speaker {
  constructor() {
    this.onSpeakingChanged = () => {};
    this.onWord = () => {};
    this.generation = 0;
    this.controller = null;
    this.audio = null;
    this.utterance = null;
    this.speaking = false;
    this.voice = null;
    this.audioContext = null;
    this.pulseFrame = 0;
    if ('speechSynthesis' in window) {
      this.pickVoice();
      speechSynthesis.addEventListener('voiceschanged', () => this.pickVoice());
    }
  }

  /** Installed voices first: Chrome's network voices can stop mid-sentence without an end event. */
  pickVoice() {
    const english = speechSynthesis.getVoices().filter((v) => v.lang === 'en-US' || v.lang === 'en_US');
    for (const voices of [english.filter((v) => v.localService), english]) {
      for (const name of NATURAL_NAMES) {
        const match = voices.find((v) => v.name.startsWith(name));
        if (match) { this.voice = match; return; }
      }
      if (voices.length) { this.voice = voices[0]; return; }
    }
    this.voice = null;
  }

  /** Starts speaking `text`; returns whether anything will be spoken. */
  speak(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    this.stop();
    const token = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.fetchAudio(trimmed, controller.signal)
      .then((blob) => {
        if (token !== this.generation) return;
        this.controller = null;
        this.playAudio(blob, token, trimmed);
      })
      .catch(() => {
        if (token !== this.generation) return;
        this.controller = null;
        this.speakOnDevice(trimmed, token);
      });
    return true;
  }

  async fetchAudio(text, signal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${config.base}/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 2000) }),
      signal: AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal,
    });
    if (response.status !== 200 || !/audio\/mpeg/i.test(response.headers.get('content-type') || '')) throw new Error('No speech audio');
    const blob = await response.blob();
    if (!blob.size) throw new Error('Empty speech audio');
    return blob;
  }

  playAudio(blob, token, text) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.audio = audio;
    this.audioUrl = url;
    // Ended, paused from outside the page (media keys), or stopped: the blob is freed every way playback ends.
    const finish = () => {
      URL.revokeObjectURL(url);
      if (this.audio !== audio) return;
      this.audio = null;
      this.audioUrl = null;
      this.stopPulses();
      this.setSpeaking(false);
    };
    audio.addEventListener('playing', () => {
      if (token !== this.generation) return;
      this.setSpeaking(true);
      this.startPulses(audio);
    }, { once: true });
    audio.addEventListener('ended', finish);
    audio.addEventListener('pause', finish);
    audio.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      if (this.audio !== audio || token !== this.generation) return;
      this.audio = null;
      this.audioUrl = null;
      this.speakOnDevice(text, token);
    });
    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      if (this.audio !== audio || token !== this.generation) return;
      this.audio = null;
      this.audioUrl = null;
      this.speakOnDevice(text, token);
    });
  }

  speakOnDevice(text, token) {
    if (!('speechSynthesis' in window) || token !== this.generation) { this.setSpeaking(false); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) utterance.voice = this.voice;
    utterance.lang = 'en-US';
    utterance.rate = 0.95;
    utterance.onstart = () => { if (this.utterance === utterance) this.setSpeaking(true); };
    utterance.onboundary = (event) => { if (this.utterance === utterance && event.name !== 'sentence') this.onWord(); };
    const finish = () => {
      if (this.utterance !== utterance) return;
      this.utterance = null;
      this.setSpeaking(false);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    this.utterance = utterance;
    speechSynthesis.speak(utterance);
  }

  /** The beak opens on each rise in loudness, the audio stand-in for spoken-word callbacks. */
  startPulses(audio) {
    this.stopPulses();
    try {
      this.audioContext = this.audioContext || new AudioContext();
      const source = this.audioContext.createMediaElementSource(audio);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyser.connect(this.audioContext.destination);
      const samples = new Uint8Array(analyser.fftSize);
      let quiet = true;
      let lastPulse = 0;
      const step = (now) => {
        if (this.audio !== audio) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += ((s - 128) / 128) ** 2;
        const level = Math.sqrt(sum / samples.length);
        if (level > 0.08 && quiet && now - lastPulse > 110) { this.onWord(); lastPulse = now; quiet = false; }
        if (level < 0.04) quiet = true;
        this.pulseFrame = requestAnimationFrame(step);
      };
      this.pulseFrame = requestAnimationFrame(step);
    } catch {
      this.pulseTimer = setInterval(() => { if (this.audio === audio) this.onWord(); }, 240);
    }
  }

  stopPulses() {
    cancelAnimationFrame(this.pulseFrame);
    clearInterval(this.pulseTimer);
  }

  /** "Stopped" is always reported: speech can fail before it ever started, and the model must not stay in speaking. */
  setSpeaking(speaking) {
    if (speaking && this.speaking) return;
    this.speaking = speaking;
    this.onSpeakingChanged(speaking);
  }

  stop() {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.audio) {
      const audio = this.audio;
      this.audio = null;
      audio.pause();
      audio.removeAttribute('src');
    }
    if (this.audioUrl) { URL.revokeObjectURL(this.audioUrl); this.audioUrl = null; }
    this.stopPulses();
    this.utterance = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.setSpeaking(false);
  }
}
