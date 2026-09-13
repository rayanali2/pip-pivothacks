import { Router } from 'express';

/** Keep provider credentials on the server; clients receive only audio. */
export function speechRouter(): Router {
  const router = Router();
  router.post('/speech', async (req, res) => {
    const text: unknown = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
      res.status(400).json({ error: 'Text must contain 1–2000 characters.' });
      return;
    }
    const key = process.env.ELEVENLABS_API_KEY?.trim();
    if (!key) {
      res.status(503).json({ error: 'Speech is unavailable.' });
      return;
    }
    const voice = process.env.ELEVENLABS_VOICE_ID?.trim() || 'EXAVITQu4vr4xnSDxMaL';
    const setting = (name: string, fallback: number, min: number, max: number): number => {
      const raw = process.env[name]?.trim();
      const value = raw ? Number(raw) : NaN;
      return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    };
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: text.trim(),
          model_id: process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_flash_v2_5',
          voice_settings: {
            stability: setting('ELEVENLABS_STABILITY', 0.4, 0, 1),
            similarity_boost: 0.75,
            style: 0,
            use_speaker_boost: false,
            speed: setting('ELEVENLABS_SPEED', 1.03, 0.7, 1.2),
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Speech provider unavailable');
      const audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length) throw new Error('Empty audio');
      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).send(audio);
    } catch {
      // Never forward provider errors, request headers, or credentials.
      res.status(502).json({ error: 'Speech is unavailable. Use the device voice.' });
    }
  });
  return router;
}
