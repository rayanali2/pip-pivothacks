// Renders every view against the API's offline fixtures in Node with minimal browser stubs.
// Run from the repo root: node extension/test/render.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../ios/Pip/Pip/Resources/Offline');
const load = (name) => JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), 'utf8'));

const noop = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.document = { addEventListener: noop, querySelectorAll: () => [], querySelector: () => null };
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, runtime: { sendMessage: async () => {} } };

const { state } = await import('../js/model.js');
const { layoutTimeline } = await import('../js/timeline.js');
const { renderHome } = await import('../js/views/home.js');
const { renderToday } = await import('../js/views/today.js');
const { renderSchedule } = await import('../js/views/schedule.js');
const { renderHistory } = await import('../js/views/history.js');
const { renderDetail } = await import('../js/views/detail.js');
const { renderFocus } = await import('../js/views/focus.js');
const { renderCalendarSheet, renderRemindersSheet, renderAddBlockSheet } = await import('../js/views/sheets.js');

const capture = load('capture_voice');
const rerank = load('rerank_25');
const ui = { expandedRules: new Map([['home:demo-return-headphones', 0]]), homeText: '', followText: '', scheduleFilter: 'all', historyMode: 'decisions', actionsOnly: false };

let failures = 0;
const check = (label, fn) => {
  try {
    const out = String(fn());
    if (out.includes('undefined') || out.includes('[object Object]') || out.includes('NaN')) {
      const at = out.search(/undefined|\[object Object\]|NaN/);
      throw new Error(`suspicious output near: ${out.slice(Math.max(0, at - 120), at + 40)}`);
    }
    console.log(`ok   ${label} (${out.length} chars)`);
    return out;
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${label}: ${error.stack}`);
    return '';
  }
};

for (const [name, plan] of [['capture', capture.plan], ['rerank 25', rerank.plan]]) {
  const layout = layoutTimeline(plan);
  console.log(`\n${name}: now ${layout.nowText}; tray [${layout.tray.map((t) => `${t.item.title}:${t.reason.kind}`).join(', ')}]`);
  layout.rows.forEach((r) => console.log(`  ${r.type.padEnd(5)} y=${r.y.toFixed(1).padStart(6)} ${r.type === 'entry' ? `${r.style}: ${r.item.title} (${r.text}) h=${r.height.toFixed(0)}` : r.label}`));
}

Object.assign(state, {
  currentPlan: capture.plan, tasks: capture.tasks, transcript: capture.transcript, draft: capture.transcript, hasCapture: true,
  todayTimetable: load('timetable_today'), weekTimetable: load('timetable_week').blocks, profile: load('profile').profile,
  history: load('history').entries, pivotLog: load('pivot_log').entries, health: load('health'), isOffline: false, lastSource: 'snowflake',
  pipelineStages: capture.pipeline, revealedStageCount: 2,
});

console.log('');
check('home (result)', () => renderHome(state, ui));
state.isRevealingPipeline = true; state.pipState = 'thinking';
check('home (pipeline reveal)', () => renderHome(state, ui));
state.isRevealingPipeline = false; state.pipState = 'idle';
check('today (capture)', () => renderToday(state, ui));
state.currentPlan = rerank.plan; state.lastDiff = rerank.diff; state.highlighted = new Set(rerank.diff.moves.map((m) => m.item_id));
check('today (rerank 25)', () => renderToday(state, ui));
state.overrunPreview = { itemId: rerank.plan.do_now.item_id, headline: 'With 15 minutes, nothing fits.', doNowTitle: null, changed: true };
check('today (overrun preview)', () => renderToday(state, ui));
check('schedule', () => renderSchedule(state, ui));
check('history', () => renderHistory(state, ui));
check('pivot log', () => renderHistory(state, { ...ui, historyMode: 'pivots' }));
const item = capture.plan.do_now;
check('detail', () => renderDetail(item, capture.tasks.find((t) => t.task_id === item.task_id), capture.plan.reasoning.now, state));
check('focus', () => renderFocus({ id: 'f', item, title: item.title, action: item.action, startedAt: Date.now(), endsAt: Date.now() + 2100000, plannedMinutes: 35, extendedMinutes: 0, nextLabel: 'CHEM 110 Lab · 2:00 PM', nextLocation: 'Science Hall 204', moneyAtRisk: 79 }, state));
check('calendar sheet', () => renderCalendarSheet(state.currentPlan));
check('reminders sheet', () => renderRemindersSheet(state.currentPlan, [{ id: 'r', title: 'Return headphones', date: Date.now() + 60000, notify: true, completed: false }], null));
check('add block sheet', () => renderAddBlockSheet());
state.currentPlan = null; state.hasCapture = false;
check('home (empty)', () => renderHome(state, ui));
check('today (empty)', () => renderToday(state, ui));

console.log(`\n${failures ? `${failures} FAILED` : 'all views rendered'}`);
process.exit(failures ? 1 : 0);
