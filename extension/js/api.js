// HTTP client for the Pip API (docs/CONTRACT.md), with the same identity rules as ios/Pip/Pip/Config.swift:
// a stable per-install student ID, and the shared "demo" student only in developer demo mode.

export const DEFAULT_BASE = 'http://localhost:3000';
const TIMEOUT_MS = 120000;

export const config = {
  base: DEFAULT_BASE,
  demoMode: false,
  installId: '',
  muted: false,
  get studentId() { return this.demoMode ? 'demo' : this.installId; },
};

export async function loadConfig() {
  const saved = await chrome.storage.local.get(['base', 'demoMode', 'installId', 'muted']);
  config.base = typeof saved.base === 'string' && saved.base ? saved.base : DEFAULT_BASE;
  config.demoMode = saved.demoMode === true;
  config.muted = saved.muted === true;
  if (typeof saved.installId === 'string' && saved.installId && saved.installId !== 'demo') {
    config.installId = saved.installId;
  } else {
    config.installId = `student-${crypto.randomUUID()}`;
    await chrome.storage.local.set({ installId: config.installId });
  }
}

export async function saveConfig(patch) {
  Object.assign(config, patch);
  await chrome.storage.local.set(patch);
}

/** Only local HTTP addresses: the extension's host permissions cover localhost and 127.0.0.1. */
export function normalizeBase(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) return null;
  return url.origin;
}

export class ApiError extends Error {
  constructor(message, { offline = false, status = 0 } = {}) {
    super(message);
    this.offline = offline;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, query } = {}) {
  const url = new URL(config.base + path);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const init = { method, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    throw new ApiError(
      timedOut ? 'Pip took too long to answer. Try again.' : `Can't reach Pip at ${config.base}. Start the API with npm run dev, then try again.`,
      { offline: !timedOut },
    );
  }
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON error body */ }
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status})`, { status: response.status });
  return data;
}

const student = () => ({ student_id: config.studentId });

export const api = {
  health: (refresh = false) => request('/health', { query: refresh ? { refresh: '1' } : {} }),
  captureText: (text, followupPlanId = null) =>
    request('/captures/text', { method: 'POST', body: { ...student(), text, followup_plan_id: followupPlanId } }),
  captureVoice(blob, { followupPlanId = null, clientTranscript = null } = {}) {
    const form = new FormData();
    form.append('student_id', config.studentId);
    if (followupPlanId) form.append('followup_plan_id', followupPlanId);
    if (clientTranscript) form.append('client_transcript', clientTranscript);
    const extension = /webm/i.test(blob.type) ? 'webm' : 'm4a';
    form.append('audio', blob, `capture.${extension}`);
    return request('/captures/voice', { method: 'POST', body: form });
  },
  rerank: (planId, context, preview = false) =>
    request('/plans/rerank', { method: 'POST', body: { ...student(), plan_id: planId, context, preview } }),
  action: (planId, taskId, kind) =>
    request('/actions', { method: 'POST', body: { ...student(), plan_id: planId, task_id: taskId, kind } }),
  timetableToday: () => request('/timetable/today', { query: student() }),
  timetable: () => request('/timetable', { query: student() }),
  putTimetable: (blocks) => request('/timetable', { method: 'PUT', body: { ...student(), blocks } }),
  profile: () => request('/profile', { query: student() }),
  putProfile: (patch) => request('/profile', { method: 'PUT', body: { ...student(), ...patch } }),
  history: () => request('/history', { query: student() }),
  pivotLog: () => request('/pivot-log'),
  resetDemo: () => request('/demo/reset', { method: 'POST', body: student() }),
};
