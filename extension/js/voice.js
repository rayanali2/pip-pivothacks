// Voice capture: MediaRecorder for the audio file, plus Chrome's speech recognition running alongside it.
// The recognized words ride along as client_transcript, like the iPhone's on-device transcript,
// so the API still has the words when Snowflake can't transcribe the recording.

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
const MAX_SECONDS = 60;

export async function microphonePermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'prompt';
  }
}

/** Chrome's side panel can't show the microphone prompt, so a normal tab asks once for the extension. */
export function openPermissionTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

export class Recorder {
  constructor() {
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.recognition = null;
    this.finalWords = '';
    this.interimWords = '';
    this.timer = null;
    this.onAutoStop = () => {};
  }

  get isRecording() { return this.recorder?.state === 'recording'; }

  async start() {
    const mime = MIME_TYPES.find((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('This Chrome version can’t record audio. Type your day instead.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
    this.recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
    this.recorder.start();
    this.startRecognition();
    this.timer = setTimeout(() => { if (this.isRecording) this.onAutoStop(); }, MAX_SECONDS * 1000);
  }

  startRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.finalWords = '';
    this.interimWords = '';
    if (!Recognition) return;
    try {
      const recognition = new Recognition();
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal) this.finalWords += `${result[0].transcript} `;
          else interim += result[0].transcript;
        }
        this.interimWords = interim;
      };
      recognition.onerror = () => {};
      recognition.start();
      this.recognition = recognition;
    } catch {
      this.recognition = null;
    }
  }

  /** Stops and resolves { blob, transcript }. transcript waits briefly for the last words. */
  stop() {
    clearTimeout(this.timer);
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve(null);
    const recognition = this.recognition;
    this.recognition = null;

    const words = new Promise((resolve) => {
      if (!recognition) { resolve(''); return; }
      const done = () => resolve(`${this.finalWords} ${this.interimWords}`.replace(/\s+/g, ' ').trim());
      const fallback = setTimeout(done, 1500);
      recognition.onend = () => { clearTimeout(fallback); done(); };
      try { recognition.stop(); } catch { clearTimeout(fallback); done(); }
    });

    const audio = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
      if (recorder.state !== 'inactive') recorder.stop(); else resolve(new Blob(this.chunks, { type: recorder.mimeType }));
    });

    return Promise.all([audio, words]).then(([blob, transcript]) => {
      this.release();
      return { blob, transcript: transcript || null };
    });
  }

  discard() {
    clearTimeout(this.timer);
    try { this.recognition?.abort(); } catch { /* already stopped */ }
    this.recognition = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }

  release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }
}
