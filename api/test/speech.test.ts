import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { mockService } from './helpers';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('recommendation speech', () => {
  it('rejects invalid input before contacting the provider', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const app = createApp(mockService());
    for (const text of ['', ' ', 12, 'a'.repeat(2001)]) {
      expect((await request(app).post('/speech').send({ text })).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns a fallback response when unconfigured', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    expect((await request(createApp(mockService())).post('/speech').send({ text: 'Do now: return the headphones.' })).status).toBe(503);
  });

  it('returns audio without exposing credentials or caching it', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-only-credential');
    vi.stubEnv('ELEVENLABS_VOICE_ID', 'test-voice');
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } }));
    vi.stubGlobal('fetch', fetcher);
    const response = await request(createApp(mockService())).post('/speech').send({ text: 'Do now: return the headphones.' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('audio/mpeg');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(Buffer.from([73, 68, 51]));
    expect(fetcher.mock.calls[0]?.[0]).toContain('/test-voice?');
  });

  it('redacts upstream errors so device speech can take over', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-only-credential');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test-only-credential')));
    const response = await request(createApp(mockService())).post('/speech').send({ text: 'Next task.' });
    expect(response.status).toBe(502);
    expect(response.text).not.toContain('test-only-credential');
  });
});
