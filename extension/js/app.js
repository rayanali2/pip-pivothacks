// Side panel shell: tab bar (UniMate · Today · Schedule · History like RootView.swift), per-tab navigation
// stacks for task detail, sheets, the focus overlay and the banner. One delegated event layer.

import { $, $$, flip, html } from './dom.js';
import { allItems, parse } from './format.js';
import { tickCountdowns } from './components.js';
import { i } from './components.js';
import * as model from './model.js';
import { state } from './model.js';
import { allPenguins, penguinFor } from './penguin.js';
import { settleTimeline } from './timeline.js';
import { DEMO_SENTENCE, renderHome } from './views/home.js';
import { renderToday } from './views/today.js';
import { renderSchedule } from './views/schedule.js';
import { renderHistory } from './views/history.js';
import { renderDetail } from './views/detail.js';
import { focusTimeUp, renderFocus, tickFocus } from './views/focus.js';
import {
  addReminder, calendarDraft, completeReminder, deleteReminder, googleCalendarUrl, icsFile, loadReminders,
  localInputValue, readBlock, renderAddBlockSheet, renderCalendarSheet, renderRemindersSheet,
} from './views/sheets.js';

const TABS = [
  { id: 'home', label: 'UniMate', symbol: 'bird' },
  { id: 'today', label: 'Today', symbol: 'checklist' },
  { id: 'schedule', label: 'Schedule', symbol: 'calendar' },
  { id: 'history', label: 'History', symbol: 'history' },
];

const ui = {
  stacks: { home: [], today: [], schedule: [], history: [] },
  scroll: {},
  expandedRules: new Map(),
  homeText: '',
  followText: '',
  scheduleFilter: 'all',
  historyMode: 'decisions',
  actionsOnly: false,
  sheet: null,
  reminders: [],
  reminderError: null,
  profileSaving: false,
  profileSaved: false,
};

const root = document.getElementById('app');
let lastFocusRequest = 0;
let lastFocusTimeUp = null;
let micHeld = false;

// MARK: Render

function findItem(itemId) {
  return allItems(state.currentPlan).find((item) => item.item_id === itemId) || null;
}

function screen() {
  const stack = ui.stacks[state.tab];
  const top = stack[stack.length - 1];
  if (top) {
    const item = findItem(top.itemId);
    if (item) return renderDetail(item, model.taskFor(item), top.planNow, state);
    stack.length = 0;
  }
  switch (state.tab) {
    case 'today': return renderToday(state, ui);
    case 'schedule': return renderSchedule(state, ui);
    case 'history': return renderHistory(state, ui);
    default: return renderHome(state, ui);
  }
}

function sheet() {
  switch (ui.sheet) {
    case 'calendar': return renderCalendarSheet(state.currentPlan);
    case 'reminders': return renderRemindersSheet(state.currentPlan, ui.reminders, ui.reminderError);
    case 'addBlock': return renderAddBlockSheet();
    default: return '';
  }
}

function render() {
  // Keep what the student typed in fields that aren't bound to state, plus focus and caret.
  const kept = $$('input[id], textarea[id], select[id]', root)
    .filter((el) => el.dataset.dirty === 'true')
    .map((el) => ({ id: el.id, value: el.value, checked: el.checked }));
  const active = document.activeElement;
  const focusId = active && root.contains(active) ? active.id : null;
  const selection = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const settle = flip(root);
  // Entrance animations run once: anything already on screen keeps still through re-renders.
  const shown = new Set($$('[data-anim]', root).map((el) => el.dataset.anim));

  root.innerHTML = String(html`
    ${state.banner ? html`<div class="banner" role="alert" data-anim="banner:${state.banner}">${i('info', 16, 'accent-text')}<span>${state.banner}</span><button type="button" class="icon-button plain small" data-action="banner-dismiss" aria-label="Dismiss">${i('x', 13)}</button></div>` : ''}
    <main class="screen" data-tab="${state.tab}">${screen()}</main>
    <nav class="tab-bar" aria-label="Main">${TABS.map((t) => html`<button type="button" data-action="tab" data-tab="${t.id}" aria-current="${t.id === state.tab ? 'page' : 'false'}" class="${t.id === state.tab ? 'on' : ''}">${i(t.symbol, 22)}<span>${t.label}</span></button>`)}</nav>
    ${sheet()}
    ${state.focusSession ? renderFocus(state.focusSession, state) : ''}
  `);

  $$('[data-anim]', root).forEach((el) => { if (shown.has(el.dataset.anim)) el.classList.add('settled'); });

  kept.forEach(({ id, value, checked }) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = checked; else el.value = value;
    el.dataset.dirty = 'true';
  });
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (selection && 'setSelectionRange' in el) { try { el.setSelectionRange(...selection); } catch { /* not a text field */ } }
    }
  }

  $$('.penguin-slot', root).forEach((slot) => {
    const penguin = penguinFor(slot.dataset.penguin);
    penguin.set(slot.dataset.state, slot.dataset.ready === 'true');
    slot.appendChild(penguin.root);
  });
  $$('textarea.field', root).forEach(autosize);
  settleTimeline(root);
  tick();
  settle();

  if (state.textFocusRequest !== lastFocusRequest) {
    lastFocusRequest = state.textFocusRequest;
    if (state.tab === 'home') document.getElementById('home-input')?.focus();
  }
  lastFocusTimeUp = state.focusSession ? focusTimeUp(state.focusSession) : null;
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

/** Scenario clock for the current plan; any other plan's clock stays frozen at its own now. */
function nowFor(planNow) {
  if (state.currentPlan?.reasoning.now === planNow) return model.scenarioNow();
  return parse(planNow) || new Date();
}

function tick() {
  tickCountdowns(root, nowFor);
  tickFocus(root);
  $$('[data-elapsed]', root).forEach((el) => {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(el.dataset.elapsed)) / 1000));
    el.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });
}

setInterval(() => {
  tick();
  if (state.focusSession && focusTimeUp(state.focusSession) !== lastFocusTimeUp) render();
}, 1000);

// MARK: Navigation

function setTab(tab) {
  ui.scroll[state.tab] = window.scrollY;
  if (tab === state.tab) {
    ui.stacks[tab].length = 0;
    window.scrollTo({ top: 0 });
  }
  model.setTab(tab);
  if (tab === 'history') { model.refreshHistory(); model.refreshPivotLog(); }
  if (tab === 'schedule') { model.refreshSchedule(); model.refreshProfile(); }
  requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: ui.scroll[tab] || 0 })));
}

function openDetail(itemId) {
  const plan = state.currentPlan;
  if (!plan || !findItem(itemId)) return;
  ui.scroll[`${state.tab}:root`] = window.scrollY;
  ui.stacks[state.tab].push({ itemId, planNow: plan.reasoning.now });
  state.actionMessage = null;
  render();
  window.scrollTo({ top: 0 });
}

async function openSheet(name) {
  ui.sheet = name;
  ui.reminderError = null;
  if (name === 'reminders') ui.reminders = await loadReminders();
  render();
  $('.sheet input, .sheet select', root)?.focus();
}

function closeSheet() { ui.sheet = null; render(); }

function fillFromPlannedItem(itemId, fields) {
  const item = findItem(itemId);
  if (!item) return;
  const start = parse(item.starts_at || item.due_at) || new Date(Date.now() + 3600000);
  fields(item, start);
}

// MARK: Actions

const actions = {
  tab: (el) => setTab(el.dataset.tab),
  back: () => {
    ui.stacks[state.tab].pop();
    render();
    window.scrollTo({ top: ui.scroll[`${state.tab}:root`] || 0 });
  },
  mute: () => model.toggleMute(),
  'banner-dismiss': () => model.dismissBanner(),
  'open-detail': (el) => openDetail(el.dataset.item),
  'start-now': (el) => { const item = findItem(el.dataset.item); if (item) model.startNow(item); },
  record: (el) => { const item = findItem(el.dataset.item); if (item) model.record(el.dataset.kind, item); },
  overrun: (el) => { const item = findItem(el.dataset.item); if (item) model.previewPlanOverrun(item); },
  rule: (el) => {
    const key = el.dataset.key;
    const index = Number(el.dataset.index);
    if (ui.expandedRules.get(key) === index) ui.expandedRules.delete(key); else ui.expandedRules.set(key, index);
    render();
  },
  preset: (el) => model.setAvailableMinutes(el.dataset.preset),
  'follow-chip': (el) => model.followUp(el.dataset.prompt),
  scan: () => model.scanTab(),
  'demo-sentence': () => { ui.homeText = DEMO_SENTENCE; render(); document.getElementById('home-input')?.focus(); },
  'focus-input': () => document.getElementById('home-input')?.focus(),
  'update-transcript': () => model.submitEditedTranscript(),

  sheet: (el) => openSheet(el.dataset.sheet),
  'sheet-close': () => closeSheet(),
  'sheet-close-backdrop': (el, event) => { if (event.target === el) closeSheet(); },
  'cal-google': () => {
    try { chrome.tabs.create({ url: googleCalendarUrl(calendarDraft(root)) }); $('#cal-status', root).textContent = 'Tap Save in Google Calendar to finish. UniMate can’t confirm it saved.'; } catch (error) { model.showBanner(error.message); }
  },
  'cal-ics': () => {
    try {
      const draft = calendarDraft(root);
      const url = URL.createObjectURL(new Blob([icsFile(draft)], { type: 'text/calendar' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${draft.title.replace(/[^\w -]+/g, '').trim() || 'pip-event'}.ics`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      $('#cal-status', root).textContent = 'Open the downloaded file to add it to your calendar.';
    } catch (error) { model.showBanner(error.message); }
  },
  'rem-add': async () => {
    const title = $('#rem-title', root).value.trim();
    const when = new Date($('#rem-when', root).value).getTime();
    const notify = $('#rem-notify', root).checked;
    if (!title || Number.isNaN(when)) { ui.reminderError = 'Add what to remember and when.'; render(); return; }
    try {
      ui.reminders = await addReminder({ title, when, notify });
      ui.reminderError = null;
      $$('.sheet [data-dirty]', root).forEach((el) => delete el.dataset.dirty);
      render();
      $('#rem-title', root).value = '';
    } catch (error) { ui.reminderError = error.message; render(); }
  },
  'rem-done': async (el) => { ui.reminders = await completeReminder(el.dataset.id); render(); },
  'rem-delete': async (el) => { ui.reminders = await deleteReminder(el.dataset.id); render(); },
  'block-add': async () => {
    const block = readBlock(root);
    if (!block) return;
    ui.sheet = null;
    render();
    await model.saveTimetable([...state.weekTimetable, block]);
  },
  'block-delete': (el) => {
    const remaining = state.weekTimetable.filter((b) => !(b.day_of_week === Number(el.dataset.day) && b.starts_at === el.dataset.start && b.title === el.dataset.title));
    model.saveTimetable(remaining);
  },
  'schedule-filter': (el) => { ui.scheduleFilter = ui.scheduleFilter === el.dataset.filter ? 'all' : el.dataset.filter; render(); },
  'reset-demo': () => model.resetDemo(),

  'history-refresh': () => { model.refreshHistory(); model.refreshPivotLog(); },
  'history-mode': () => { ui.historyMode = ui.historyMode === 'pivots' ? 'decisions' : 'pivots'; render(); },
  'history-all': () => { ui.actionsOnly = false; ui.historyMode = 'decisions'; render(); },
  'history-actions': () => { ui.actionsOnly = !ui.actionsOnly; ui.historyMode = 'decisions'; render(); },

  'focus-close': () => model.finishFocus(false),
  'focus-done': () => model.finishFocus(true),
  'focus-extend': () => model.extendFocus(10),
  'focus-stuck': () => model.focusStuck(),
  'focus-skip': () => model.skipFocusToEnd(),
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || !root.contains(el) || el.disabled) return;
  const action = actions[el.dataset.action];
  if (!action) return;
  if (el.tagName === 'A' || el.tagName === 'BUTTON') event.preventDefault();
  action(el, event);
});

// Keyboard and assistive tech: a click with no pointer toggles recording.
document.addEventListener('click', (event) => {
  const mic = event.target.closest('[data-mic]');
  if (!mic || mic.disabled || event.detail !== 0) return;
  if (state.pipState === 'listening') model.stopRecordingAndSend();
  else model.pressMic(mic.dataset.mic === 'follow');
});

document.addEventListener('pointerdown', (event) => {
  const mic = event.target.closest('[data-mic]');
  if (!mic || mic.disabled || event.button !== 0) return;
  event.preventDefault();
  micHeld = true;
  model.pressMic(mic.dataset.mic === 'follow');
});

// The mic button re-renders while held, so the release is read from the window.
const release = () => { if (!micHeld) return; micHeld = false; model.releaseMic(); };
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
window.addEventListener('blur', release);

document.addEventListener('input', (event) => {
  const el = event.target;
  if (!root.contains(el)) return;
  if (el.matches('textarea.field')) autosize(el);
  const bind = el.dataset.bind;
  if (!bind) { if (el.id) el.dataset.dirty = 'true'; return; }
  if (bind === 'draft') { model.setDraft(el.value); render(); return; }
  ui[bind] = el.value;
  const send = el.closest('form')?.querySelector('.send');
  if (send) send.disabled = !el.value.trim() || model.isBusy();
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (!root.contains(el)) return;
  if (el.id) el.dataset.dirty = 'true';
  switch (el.dataset.actionChange) {
    case 'demo-mode':
      ui.stacks = { home: [], today: [], schedule: [], history: [] };
      ui.historyMode = 'decisions';
      model.setDemoMode(el.checked);
      break;
    case 'cal-planned':
      fillFromPlannedItem(el.value, (item, start) => {
        const end = parse(item.ends_at) || new Date(start.getTime() + Math.max(item.est_minutes || 60, 1) * 60000);
        $('#cal-title', root).value = item.title;
        $('#cal-start', root).value = localInputValue(start);
        $('#cal-end', root).value = localInputValue(end);
        $('#cal-location', root).value = item.location || '';
        ['#cal-title', '#cal-start', '#cal-end', '#cal-location'].forEach((id) => { $(id, root).dataset.dirty = 'true'; });
      });
      break;
    case 'rem-planned':
      fillFromPlannedItem(el.value, (item, start) => {
        $('#rem-title', root).value = item.title;
        $('#rem-when', root).value = localInputValue(start);
        $('#rem-title', root).dataset.dirty = 'true';
        $('#rem-when', root).dataset.dirty = 'true';
      });
      break;
    default:
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ui.sheet) { closeSheet(); return; }
  const el = event.target;
  if (event.key === 'Enter' && !event.shiftKey && el.matches?.('.composer textarea')) {
    event.preventDefault();
    el.form.requestSubmit();
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!root.contains(form)) return;
  event.preventDefault();
  switch (form.dataset.form) {
    case 'home-send': {
      const text = ui.homeText.trim();
      if (!text) return;
      model.sendText(text, { onAccepted: () => { if (ui.homeText.trim() === text) { ui.homeText = ''; render(); } } });
      document.activeElement?.blur();
      break;
    }
    case 'follow-send': {
      const text = ui.followText.trim();
      if (!text) return;
      model.followUp(text, () => { if (ui.followText.trim() === text) { ui.followText = ''; render(); } });
      document.activeElement?.blur();
      break;
    }
    case 'profile': {
      const cash = Number(String($('#profile-cash', root).value).replace(',', '.'));
      const patch = {
        chronotype: $('#profile-chronotype', root).value,
        cooks_own_meals: $('#profile-cooks', root).checked,
        budget_until: $('#profile-until', root).value || null,
        procrastinates_on: $('#profile-procrastinates', root).value || null,
      };
      if (Number.isFinite(cash) && $('#profile-cash', root).value !== '') patch.cash_available = cash;
      ui.profileSaving = true;
      ui.profileSaved = false;
      render();
      const ok = await model.saveProfile(patch);
      ui.profileSaving = false;
      ui.profileSaved = ok;
      if (ok) $$('[id^="profile-"]', root).forEach((el) => delete el.dataset.dirty);
      render();
      break;
    }
    case 'server':
      await model.testConnection($('#server-url', root).value);
      delete $('#server-url', root)?.dataset.dirty;
      break;
    default:
  }
});

model.wordListeners.add(() => allPenguins().forEach((p) => p.word()));
model.subscribe(render);

render();
model.bootstrap();
