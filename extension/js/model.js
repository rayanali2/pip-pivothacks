// Port of ios/Pip/Pip/State/AppModel.swift. One observable state object plus the same actions:
// capture (voice/text), pipeline reveal, follow-ups, timeline presets, overrun preview, actions,
// focus sessions, schedule/profile/history, connection and banners.

import { api, config, loadConfig, normalizeBase, saveConfig } from './api.js';
import { parse } from './format.js';
import { Speaker } from './speaker.js';
import { microphonePermission, openPermissionTab, Recorder } from './voice.js';

export const PRESETS = [
  { id: 'full', label: 'Full window', minutes: null },
  { id: 'fortyEight', label: '48 min', minutes: 48 },
  { id: 'twentyFive', label: '25 min', minutes: 25 },
];

const STAGE_REVEAL_MS = 450;
const REVEAL_SETTLE_MS = 500;
const TAP_THRESHOLD_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const listeners = new Set();

export const state = {
  pipState: 'idle', // idle | listening | thinking | speaking
  transcript: '',
  draft: '',
  needsText: false,
  hasCapture: false,
  isFollowUpRecording: false,
  submittedText: '',
  textFocusRequest: 0,

  currentPlan: null,
  lastDiff: null,
  tasks: [],
  highlighted: new Set(),
  startNowConfirmation: null,
  actionMessage: null,
  planReceivedAt: Date.now(),
  availablePreset: 'full',
  overrunPreview: null,
  overrunLoading: false,

  pipelineStages: [],
  revealedStageCount: 0,
  isRevealingPipeline: false,

  focusSession: null,

  todayTimetable: null,
  weekTimetable: [],
  profile: null,
  history: [],
  pivotLog: [],

  lastSource: 'fallback',
  health: null,
  isOffline: true,
  connectionStatus: null,
  testingConnection: false,

  muted: false,
  banner: null,
  tab: 'home',
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let emitQueued = false;
export function emit() {
  if (emitQueued) return;
  emitQueued = true;
  requestAnimationFrame(() => { emitQueued = false; listeners.forEach((fn) => fn(state)); });
}

function set(patch) { Object.assign(state, patch); emit(); }

export const isBusy = () => state.pipState === 'thinking';
export const taskFor = (item) => (item?.task_id ? state.tasks.find((t) => t.task_id === item.task_id) || null : null);

/** The plan's scenario clock advanced by the real time since the plan arrived. */
export function scenarioNow(at = Date.now()) {
  const planNow = parse(state.currentPlan?.reasoning?.now);
  return planNow ? new Date(planNow.getTime() + (at - state.planReceivedAt)) : new Date(at);
}

const speaker = new Speaker();
const recorder = new Recorder();
let planRevision = 0;
let overrunRevision = 0;
let revealTimer = 0;
let highlightTimer = 0;
let bannerTimer = 0;
let pressStartedAt = 0;
let starting = false;
let stopWhenReady = false;
export const wordListeners = new Set();

speaker.onSpeakingChanged = (speaking) => {
  if (speaking && state.pipState === 'idle') set({ pipState: 'speaking' });
  else if (!speaking && state.pipState === 'speaking') set({ pipState: 'idle' });
};
speaker.onWord = () => wordListeners.forEach((fn) => fn());
recorder.onAutoStop = () => stopRecordingAndSend();

// MARK: Launch

export async function bootstrap() {
  await loadConfig();
  state.muted = config.muted;
  const saved = await chrome.storage.session.get(['plan', 'tasks', 'transcript', 'hasCapture', 'source']);
  const local = await chrome.storage.local.get(['focusSession']);
  if (saved.plan?.plan_id) {
    Object.assign(state, {
      currentPlan: saved.plan, tasks: saved.tasks || [], transcript: saved.transcript || '', draft: saved.transcript || '',
      hasCapture: saved.hasCapture === true, lastSource: saved.source || 'fallback', planReceivedAt: Date.now(),
    });
    state.availablePreset = presetMatching(saved.plan) || 'full';
  }
  if (local.focusSession?.id && saved.plan?.plan_id) state.focusSession = local.focusSession;
  emit();
  await connect();
  await refreshAll();
}

export async function refreshAll() {
  await Promise.all([refreshSchedule(), refreshProfile(), refreshHistory(), refreshPivotLog()]);
}

function persistPlan() {
  chrome.storage.session.set({
    plan: state.currentPlan, tasks: state.tasks, transcript: state.transcript, hasCapture: state.hasCapture, source: state.lastSource,
  }).catch(() => {});
}

// MARK: Calls

async function call(operation) {
  try {
    const result = await operation();
    if (state.isOffline) set({ isOffline: false });
    return result;
  } catch (error) {
    if (error.offline) set({ isOffline: true, lastSource: 'fallback' });
    throw error;
  }
}

async function connect() {
  try {
    const health = await api.health(true);
    set({ health, isOffline: false, lastSource: health.source || 'fallback' });
  } catch (error) {
    set({ health: null, isOffline: true, lastSource: 'fallback' });
    if (!error.offline) showError(error);
  }
}

// MARK: Voice

/** Press on a mic button: hold to talk, or tap to start and tap again to send. */
export async function pressMic(followUp = false) {
  if (state.pipState === 'listening') { stopRecordingAndSend(); return; }
  if (state.pipState === 'thinking' || starting) return;
  pressStartedAt = Date.now();
  stopWhenReady = false;

  const permission = await microphonePermission();
  if (permission !== 'granted') {
    if (permission === 'denied') {
      showBanner('Microphone access is off. Allow it for UniMate in Chrome settings, or type instead.');
    } else {
      showBanner('Allow the microphone in the tab that just opened, then hold to talk again.');
      openPermissionTab();
    }
    requestTextFocus();
    return;
  }

  speaker.stop();
  starting = true;
  try {
    await recorder.start();
    starting = false;
    set({ pipState: 'listening', isFollowUpRecording: followUp && !!state.currentPlan, recordingStartedAt: Date.now() });
    if (stopWhenReady) stopRecordingAndSend();
  } catch (error) {
    starting = false;
    recorder.discard();
    set({ pipState: 'idle' });
    showBanner(`${error.message || 'Could not start recording.'} You can always type.`);
    requestTextFocus();
  }
}

/** Release: a hold sends; a quick tap keeps listening until the next tap. */
export function releaseMic() {
  if (Date.now() - pressStartedAt < TAP_THRESHOLD_MS) return;
  if (starting) { stopWhenReady = true; return; }
  if (state.pipState === 'listening') stopRecordingAndSend();
}

export async function stopRecordingAndSend() {
  if (state.pipState !== 'listening') return;
  const followupPlanId = state.isFollowUpRecording ? state.currentPlan?.plan_id || null : null;
  const isFollowUp = followupPlanId != null;
  set({ isFollowUpRecording: false, pipState: 'thinking' });
  const revision = beginPlanRequest(!isFollowUp);
  const result = await recorder.stop();
  if (revision !== planRevision) return;
  if (!result?.blob?.size) {
    handleFailure(new Error('UniMate didn’t catch any audio. Try again or type instead.'), revision);
    return;
  }
  set({ submittedText: result.transcript || '' });
  try {
    const response = await call(() => api.captureVoice(result.blob, { followupPlanId, clientTranscript: result.transcript }));
    handleCapture(response, { isFollowUp, revision });
  } catch (error) {
    handleFailure(error, revision);
  }
}

// MARK: Text

export function sendText(text, { label = null, onAccepted } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed || state.pipState === 'thinking') return;
  recorder.discard();
  speaker.stop();
  set({ pipState: 'thinking', submittedText: label || trimmed });
  const revision = beginPlanRequest(true);
  call(() => api.captureText(trimmed, null))
    .then((response) => {
      if (revision !== planRevision) return;
      handleCapture(response, { isFollowUp: false, revision });
      if (!response.needs_text) onAccepted?.();
    })
    .catch((error) => handleFailure(error, revision));
}

export const submitEditedTranscript = () => sendText(state.draft);

export function followUp(text, onAccepted) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const planId = state.currentPlan?.plan_id;
  if (!planId) { sendText(trimmed, { onAccepted }); return; }
  if (state.pipState === 'thinking') return;
  recorder.discard();
  speaker.stop();
  set({ pipState: 'thinking' });
  const revision = beginPlanRequest(false);
  call(() => api.captureText(trimmed, planId))
    .then((response) => {
      if (revision !== planRevision) return;
      handleCapture(response, { isFollowUp: true, revision });
      if (!response.needs_text) onAccepted?.();
    })
    .catch((error) => handleFailure(error, revision));
}

/** Reads the active tab's course-page lines and sends them as a capture (Chrome-only). */
export async function scanTab() {
  if (isBusy()) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Open the course page you want UniMate to scan, then try again.');
    if (!/^https?:/i.test(tab.url || '')) throw new Error('Chrome doesn’t let extensions read this page. Open a normal course website tab.');
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: globalThis.extractPipPageContext });
    if (!result?.text) throw new Error('UniMate couldn’t find readable text on this tab.');
    const prompt = `Course page: ${result.title}\nFind every actionable course task, due date, exam, class time, and deadline in the page excerpt below. Add them to my tasks and rank what matters now. Do not invent dates that are not shown.\n\n${result.text}`;
    sendText(prompt.slice(0, 5000), { label: `Scanned “${result.title}”` });
  } catch (error) {
    showError(error);
  }
}

// MARK: Timeline & preview

export function setAvailableMinutes(presetId) {
  const plan = state.currentPlan;
  if (!plan || state.pipState === 'thinking' || state.pipState === 'listening') return;
  const preset = PRESETS.find((p) => p.id === presetId);
  set({ availablePreset: presetId });
  const minutes = preset.minutes ?? fullWindowMinutes(plan);
  rerankCurrentPlan(plan.plan_id, minutes == null ? {} : { available_minutes: minutes });
}

export function previewPlanOverrun(item) {
  const plan = state.currentPlan;
  if (!plan) return;
  overrunRevision += 1;
  const revision = overrunRevision;
  const planId = plan.plan_id;
  set({ overrunLoading: true });
  call(() => api.rerank(planId, { available_minutes: Math.max(0, plan.reasoning.effective_minutes - 10) }, true))
    .then((response) => {
      if (revision !== overrunRevision || state.currentPlan?.plan_id !== planId) return;
      set({
        overrunLoading: false,
        overrunPreview: { itemId: item.item_id, headline: response.diff.headline, doNowTitle: response.plan.do_now?.title || null, changed: response.diff.do_now_changed },
      });
    })
    .catch((error) => {
      if (revision !== overrunRevision) return;
      set({ overrunLoading: false });
      showError(error);
    });
}

// MARK: Actions

export function startNow(item) {
  record('start_now', item);
  openFocus(item);
}

export function record(kind, item) {
  const planId = state.currentPlan?.plan_id;
  if (!planId) { showBanner('Make a plan first.'); return; }
  call(() => api.action(planId, item.task_id, kind))
    .then(async (response) => {
      state.lastSource = state.isOffline ? 'fallback' : response.source;
      if (kind === 'start_now') set({ startNowConfirmation: item.item_id });
      else set({ actionMessage: `${{ done: 'Done', defer: 'Deferred', drop: 'Dropped' }[kind]}: ${item.title} · saved to History` });
      await refreshHistory();
    })
    .catch(showError);
}

export async function toggleMute() {
  const muted = !state.muted;
  await saveConfig({ muted });
  if (muted) speaker.stop();
  set({ muted, pipState: muted && state.pipState === 'speaking' ? 'idle' : state.pipState });
}

// MARK: Focus

function openFocus(item) {
  const plan = state.currentPlan;
  if (!plan) return;
  const planned = plannedMinutes(item);
  const startedAt = Date.now();
  let nextLabel = null;
  let nextLocation = null;
  if (plan.next?.kind === 'fixed_block') {
    const at = plan.next.starts_at?.slice(11, 16);
    nextLabel = at ? `${plan.next.title} · ${formatClock(plan.next.starts_at)}` : plan.next.title;
    nextLocation = plan.next.location;
  }
  const session = {
    id: `focus-${crypto.randomUUID()}`, item, title: item.title, action: item.action,
    startedAt, endsAt: startedAt + planned * 60000, plannedMinutes: planned, extendedMinutes: 0,
    nextLabel, nextLocation, moneyAtRisk: item.money_at_risk,
  };
  setFocus(session);
}

function formatClock(iso) {
  const [h, m] = iso.slice(11, 16).split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function setFocus(session) {
  set({ focusSession: session });
  if (session) {
    chrome.storage.local.set({ focusSession: session });
    chrome.runtime.sendMessage({ type: 'focus:start', title: session.title, endsAt: session.endsAt }).catch(() => {});
  } else {
    chrome.storage.local.remove('focusSession');
    chrome.runtime.sendMessage({ type: 'focus:end' }).catch(() => {});
  }
}

export function extendFocus(minutes = 10) {
  const session = state.focusSession;
  if (!session) return;
  setFocus({ ...session, endsAt: Math.max(Date.now(), session.endsAt) + minutes * 60000, extendedMinutes: session.extendedMinutes + minutes });
}

export function finishFocus(done) {
  const session = state.focusSession;
  if (!session) return;
  setFocus(null);
  set({ startNowConfirmation: null });
  const plan = state.currentPlan;
  if (!done || !plan) return;
  const planId = plan.plan_id;
  const elapsed = Math.max(0, Math.floor((Date.now() - session.startedAt) / 60000));
  const remaining = Math.max(0, plan.reasoning.effective_minutes - elapsed);
  call(() => api.action(planId, session.item.task_id, 'done'))
    .then(async () => {
      if (state.currentPlan?.plan_id !== planId || state.pipState === 'thinking' || state.pipState === 'listening') {
        await refreshHistory();
        return;
      }
      rerankCurrentPlan(planId, { available_minutes: remaining });
    })
    .catch(showError);
}

export function focusStuck() {
  const session = state.focusSession;
  if (!session) return;
  setFocus(null);
  followUp(`I'm stuck on ${session.title}. What should I do instead?`);
}

export function skipFocusToEnd() {
  if (!config.demoMode || !state.focusSession) return;
  setFocus({ ...state.focusSession, endsAt: Date.now() + 3000 });
}

function plannedMinutes(item) {
  const start = parse(item.starts_at);
  const end = parse(item.ends_at);
  let minutes = 15;
  if (start && end && end > start) minutes = Math.round((end - start) / 60000);
  else if (item.est_minutes > 0) minutes = item.est_minutes;
  return Math.min(180, Math.max(1, minutes));
}

// MARK: Refresh

export async function refreshSchedule() {
  try { set({ todayTimetable: await call(() => api.timetableToday()) }); } catch { /* shown by connection state */ }
  try { set({ weekTimetable: (await call(() => api.timetable())).blocks }); } catch { /* shown by connection state */ }
}

export async function refreshProfile() {
  try { set({ profile: (await call(() => api.profile())).profile }); } catch { /* shown by connection state */ }
}

export async function refreshHistory() {
  try { set({ history: (await call(() => api.history())).entries }); } catch { /* shown by connection state */ }
}

export async function refreshPivotLog() {
  if (!config.demoMode) { set({ pivotLog: [] }); return; }
  try { set({ pivotLog: (await call(() => api.pivotLog())).entries }); } catch { /* shown by connection state */ }
}

export async function saveTimetable(blocks) {
  const previous = state.weekTimetable;
  set({ weekTimetable: blocks });
  try {
    const response = await call(() => api.putTimetable(blocks.map(({ day_of_week, title, starts_at, ends_at, location }) => ({ day_of_week, title, starts_at, ends_at, location: location || null }))));
    set({ weekTimetable: response.blocks });
    try { set({ todayTimetable: await call(() => api.timetableToday()) }); } catch { /* keep the old day */ }
    return true;
  } catch (error) {
    set({ weekTimetable: previous });
    showError(error);
    return false;
  }
}

export async function saveProfile(patch) {
  try {
    set({ profile: (await call(() => api.putProfile(patch))).profile });
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

export async function resetDemo() {
  if (!config.demoMode) return;
  try {
    await call(() => api.resetDemo());
    speaker.stop();
    recorder.discard();
    planRevision += 1;
    overrunRevision += 1;
    clearTimeout(revealTimer);
    setFocus(null);
    Object.assign(state, {
      currentPlan: null, lastDiff: null, tasks: [], transcript: '', draft: '', hasCapture: false, needsText: false,
      highlighted: new Set(), startNowConfirmation: null, actionMessage: null, pipelineStages: [], revealedStageCount: 0,
      isRevealingPipeline: false, overrunPreview: null, overrunLoading: false, availablePreset: 'full', pipState: 'idle',
    });
    await chrome.storage.session.remove(['plan', 'tasks', 'transcript', 'hasCapture', 'source']);
    await refreshAll();
    set({ connectionStatus: 'Demo data reset.' });
  } catch (error) {
    showError(error);
  }
}

// MARK: Server

export async function testConnection(address) {
  const base = normalizeBase(address);
  if (!base) { set({ connectionStatus: 'Use an http://localhost or http://127.0.0.1 address.' }); return; }
  set({ testingConnection: true });
  await saveConfig({ base });
  await connect();
  set({ testingConnection: false, connectionStatus: state.isOffline ? `Couldn't reach ${base}. Reconnect to create or update plans.` : `Connected to ${base}.` });
  if (!state.isOffline) await refreshAll();
}

/** Developer demo: the shared "demo" student and fixtures-style extras, like the app's --pip-demo. */
export async function setDemoMode(on) {
  if (on === config.demoMode) return;
  await saveConfig({ demoMode: on });
  speaker.stop();
  planRevision += 1;
  setFocus(null);
  Object.assign(state, {
    currentPlan: null, lastDiff: null, tasks: [], transcript: '', draft: '', hasCapture: false, needsText: false,
    pipelineStages: [], revealedStageCount: 0, isRevealingPipeline: false, overrunPreview: null, availablePreset: 'full', pipState: 'idle',
    history: [], weekTimetable: [], todayTimetable: null, profile: null,
  });
  await chrome.storage.session.remove(['plan', 'tasks', 'transcript', 'hasCapture', 'source']);
  emit();
  await refreshAll();
}

// MARK: Banner

export function showBanner(message) {
  clearTimeout(bannerTimer);
  set({ banner: message });
  bannerTimer = setTimeout(() => set({ banner: null }), 4000);
}

export function dismissBanner() { clearTimeout(bannerTimer); set({ banner: null }); }

const showError = (error) => showBanner(error?.message || 'Something went wrong.');

function requestTextFocus() { set({ textFocusRequest: state.textFocusRequest + 1 }); }

export const setTab = (tab) => set({ tab });
export const setDraft = (draft) => { state.draft = draft; };

// MARK: Private

function beginPlanRequest(revealing) {
  planRevision += 1;
  clearTimeout(revealTimer);
  if (revealing) Object.assign(state, { pipelineStages: [], revealedStageCount: 0 });
  set({ isRevealingPipeline: revealing });
  return planRevision;
}

function rerankCurrentPlan(planId, context) {
  recorder.discard();
  speaker.stop();
  set({ pipState: 'thinking' });
  const revision = beginPlanRequest(false);
  call(() => api.rerank(planId, context, false))
    .then((response) => {
      if (revision !== planRevision) return;
      state.lastSource = state.isOffline ? 'fallback' : response.source;
      showStages(response.pipeline || []);
      applyPlan(response.plan, response.diff);
    })
    .catch((error) => handleFailure(error, revision));
}

function handleCapture(response, { isFollowUp, revision }) {
  if (revision !== planRevision) return;
  state.lastSource = state.isOffline ? 'fallback' : response.source;
  state.hasCapture = true;
  if (response.needs_text) {
    Object.assign(state, { pipelineStages: response.pipeline || [], needsText: true });
    endReveal();
    if (!isFollowUp) Object.assign(state, { transcript: response.transcript, draft: response.transcript });
    else showBanner("UniMate couldn't hear that. Try typing your question.");
    requestTextFocus();
    speakOrIdle("I couldn't quite hear that. Can you type it instead?");
    return;
  }
  state.needsText = false;
  if (!isFollowUp) Object.assign(state, { transcript: response.transcript, draft: response.transcript });
  const stages = response.pipeline || [];
  if (isFollowUp || !stages.length) {
    state.tasks = response.tasks;
    showStages(stages);
    applyPlan(response.plan, response.diff);
  } else {
    revealThenApply(stages, revision, response.tasks, response.plan, response.diff);
  }
}

function revealThenApply(stages, revision, tasks, plan, diff) {
  set({ pipelineStages: stages, revealedStageCount: 0, isRevealingPipeline: true });
  const reduce = reduceMotion();
  const step = async () => {
    if (reduce) set({ revealedStageCount: stages.length });
    else {
      for (let i = 0; i < stages.length; i += 1) {
        if (i > 0) await sleep(STAGE_REVEAL_MS);
        if (revision !== planRevision) return;
        set({ revealedStageCount: i + 1 });
      }
      await sleep(STAGE_REVEAL_MS);
    }
    if (revision !== planRevision) return;
    state.tasks = tasks;
    applyPlan(plan, diff);
    await sleep(REVEAL_SETTLE_MS);
    if (revision !== planRevision) return;
    set({ isRevealingPipeline: false });
  };
  step();
}

function showStages(stages) {
  set({ pipelineStages: stages, revealedStageCount: stages.length, isRevealingPipeline: false });
}

function endReveal() {
  set({ revealedStageCount: state.pipelineStages.length, isRevealingPipeline: false });
}

function fullWindowMinutes(plan) {
  if (plan.reasoning.free_window?.minutes != null) return plan.reasoning.free_window.minutes;
  return plan.reasoning.context.available_minutes == null ? null : 1440;
}

function presetMatching(plan) {
  const minutes = plan.reasoning.context.available_minutes;
  if (minutes == null) return 'full';
  const match = PRESETS.find((p) => p.minutes === minutes);
  if (match) return match.id;
  const window = plan.reasoning.free_window?.minutes;
  return window != null && minutes >= window ? 'full' : null;
}

function applyPlan(plan, diff) {
  const highlights = new Set((diff?.moves || []).map((m) => m.item_id));
  if (diff?.do_now_changed && plan.do_now) highlights.add(plan.do_now.item_id);
  overrunRevision += 1;
  Object.assign(state, {
    currentPlan: plan, lastDiff: diff || null, highlighted: highlights, startNowConfirmation: null,
    actionMessage: null, overrunPreview: null, overrunLoading: false, planReceivedAt: Date.now(),
  });
  const preset = presetMatching(plan);
  if (preset) state.availablePreset = preset;
  emit();
  persistPlan();
  clearTimeout(highlightTimer);
  if (highlights.size) highlightTimer = setTimeout(() => set({ highlighted: new Set() }), 2500);
  speakPlan(plan, diff != null);
  refreshHistory();
}

function speakPlan(plan, isRerun) {
  const doNow = plan.do_now;
  if (!doNow) { speakOrIdle(plan.reasoning.summary); return; }
  const parts = [];
  if (isRerun && plan.reasoning.answer) parts.push(plan.reasoning.answer);
  parts.push(`Here's your next step. ${doNow.action.replace(/\.$/, '')}.`);
  parts.push(doNow.why);
  speakOrIdle(parts.join(' '));
}

function speakOrIdle(text) {
  if (!state.muted && speaker.speak(text)) set({ pipState: 'speaking' });
  else set({ pipState: 'idle' });
}

function handleFailure(error, revision) {
  if (revision !== planRevision) return;
  endReveal();
  set({ pipState: 'idle' });
  showError(error);
}

window.addEventListener('pagehide', () => { recorder.discard(); speaker.stop(); });
