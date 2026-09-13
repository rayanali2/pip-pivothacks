// Port of ios/Pip/Pip/Views/TodayPlanView.swift: focus card, save & reminders, risks, the day timeline,
// Can wait, and the follow-up bar.

import { html, raw } from '../dom.js';
import { allItems, categoryLabel, freeWindowText, opensDetail, timeLabel, windowMinutes } from '../format.js';
import { disclosure, flagPill, i, overrunPreview, planTag, sourceLabelView, stakesStrip, statusView, taskGlyph, taskMetadata, whatChanged, windowFit } from '../components.js';
import { PRESETS } from '../model.js';
import { renderTimeline } from '../timeline.js';
import { muteButton, penguinSlot, recordingStatus } from './home.js';

const CHIPS = [
  { label: '25 min', symbol: 'timer', prompt: 'I only have 25 minutes' },
  { label: 'Budget', symbol: 'card', prompt: 'What can I afford?' },
  { label: 'Why this?', symbol: 'question', prompt: 'Why not my assignment?' },
];

function focusCard(item, s, ui) {
  const plan = s.currentPlan;
  const started = s.startNowConfirmation === item.item_id;
  const available = plan.reasoning.context.available_minutes ?? plan.reasoning.free_window?.minutes;
  const used = windowMinutes(item);
  const next = plan.reasoning.free_window?.next_block_title;
  return html`<article class="card emphasized do-now ${s.highlighted.has(item.item_id) ? 'highlight' : ''}">
    <div class="row between">
      <span class="eyebrow ${started ? 'positive' : 'accent'}">${i(started ? 'checkCircle' : 'sparkle', 11)}${started ? 'In motion' : 'Do this now'}</span>
      ${taskGlyph(item.category, { size: 42 })}
    </div>
    <h2 class="title">${item.title}</h2>
    ${flagPill(item.flag)}
    ${stakesStrip(item, plan.reasoning.now, { expandedRule: ui.expandedRules.get(`today:${item.item_id}`), key: `today:${item.item_id}` })}
    ${item.due_at == null ? taskMetadata(item, plan.reasoning.now) : ''}
    ${available != null && used != null ? windowFit(used, available) : ''}
    ${next ? html`<p class="secondary-text small-label">${i('graduation', 13)}Before ${next}</p>` : ''}
    <button type="button" class="btn-primary" data-action="start-now" data-item="${item.item_id}" ${started ? raw('disabled') : ''}>${i(started ? 'check' : 'play', 16)}${started ? 'Started' : 'Start now'}</button>
    ${overrunPreview(item, s)}
    ${opensDetail(item)
    ? html`<button type="button" class="row-link" data-action="open-detail" data-item="${item.item_id}">${i('list', 15)}<span class="grow">Steps &amp; details</span>${i('external', 14)}</button>`
    : disclosure(`today:next:${item.item_id}`, 'Next step', html`<p class="secondary-text">${item.action}</p>`)}
    ${disclosure(`today:why:${item.item_id}`, 'Why first', html`<p class="secondary-text">${item.why}</p>`, { symbol: 'sparkle' })}
  </article>`;
}

function canWaitList(plan, s) {
  const items = plan.can_wait;
  return html`<section class="plan-section">
    <h2 class="heading row gap">Can wait ${items.length > 1 ? html`<span class="count">${items.length}</span>` : ''}</h2>
    <div class="list-card">${items.map((item) => {
      const row = html`${taskGlyph(item.category, { fixed: item.kind === 'fixed_block', size: 32 })}
        <span class="plan-row-body">
          <span class="eyebrow">${item.kind === 'fixed_block' ? 'Fixed' : categoryLabel(item.category)}</span>
          <strong>${item.title}</strong>
          <span class="flow"><span class="mono accent-text">${timeLabel(item, plan.reasoning.now) || 'Anytime'}</span>${flagPill(item.flag)}</span>
          ${opensDetail(item) ? html`<span class="secondary-text clamp-2">${item.why}</span>` : ''}
          ${s.highlighted.has(item.item_id) ? html`<span class="accent-text small-label">${i('refresh', 12)}Updated</span>` : ''}
        </span>`;
      return opensDetail(item)
        ? html`<button type="button" class="plan-row ${s.highlighted.has(item.item_id) ? 'highlight' : ''}" data-flip="cw-${item.item_id}" data-action="open-detail" data-item="${item.item_id}">${row}${i('chevronRight', 14, 'chevron')}</button>`
        : html`<details class="plan-row-details" data-flip="cw-${item.item_id}"><summary class="plan-row">${row}</summary><div class="plan-row-extra"><p>${item.action}</p><p class="secondary-text">${item.why}</p></div></details>`;
    })}</div>
  </section>`;
}

function followUpBar(s, ui) {
  const busy = s.pipState === 'thinking';
  const listening = s.pipState === 'listening' && s.isFollowUpRecording;
  const typed = (ui.followText || '').trim();
  return html`<div class="follow-bar">
    ${listening ? recordingStatus(s) : ''}
    <div class="chip-row">${CHIPS.map((c) => html`<button type="button" class="chip-button" data-action="follow-chip" data-prompt="${c.prompt}" aria-label="${c.prompt}" ${busy ? raw('disabled') : ''}>${i(c.symbol, 13)}${c.label}</button>`)}</div>
    <form class="composer" data-form="follow-send">
      <textarea id="follow-input" class="field" rows="1" maxlength="2000" placeholder="Adjust your plan…" data-bind="followText" aria-label="Adjust your plan">${ui.followText || ''}</textarea>
      <button type="button" class="mic tiny ${listening ? 'listening' : ''}" data-mic="follow" ${busy ? raw('disabled') : ''} aria-label="${listening ? 'Stop recording and send' : 'Hold to talk'}">${i(listening ? 'waveform' : 'mic', 17)}</button>
      <button type="submit" class="send" aria-label="Send follow-up" ${!typed || busy ? raw('disabled') : ''}>${i('arrowUp', 18)}</button>
    </form>
  </div>`;
}

export function renderToday(s, ui) {
  const plan = s.currentPlan;
  const toolbar = html`<header class="toolbar">
    <button type="button" class="icon-button plain" data-action="sheet" data-sheet="reminders" aria-label="Reminders">${i('bell', 18)}</button>
    <h1 class="nav-title">Today</h1>
    ${muteButton(s)}
  </header>`;

  if (!plan) {
    return html`<div class="page today">${toolbar}
      <section class="card empty-card">
        ${penguinSlot('today', 60, 'idle')}
        <h2 class="heading">No plan yet</h2>
        <p class="secondary-text center">Tell Pip about your day to get one next step.</p>
        <button type="button" class="btn-primary" data-action="tab" data-tab="home">${i('mic', 16)}Talk to Pip</button>
      </section></div>`;
  }

  const items = allItems(plan);
  const warnings = plan.reasoning.warnings || [];
  return html`<div class="page today with-bar">${toolbar}
    <div class="flow header-flow">
      ${freeWindowText(plan) ? html`<span class="free-window">${i('hourglass', 13)}${freeWindowText(plan)}</span>` : ''}
      <span class="mono secondary-text">${items.filter((x) => x.kind !== 'fixed_block').length} tasks · ${items.filter((x) => x.kind === 'fixed_block').length} fixed</span>
      ${s.pipState === 'thinking' ? raw('<span class="spinner small"></span>') : ''}
      ${sourceLabelView(s.lastSource)}
    </div>
    ${s.lastDiff ? whatChanged(s.lastDiff.headline) : ''}
    ${s.pipState === 'thinking' ? html`<section class="card">${statusView('', 'Updating your plan', 'Checking what fits now', { loading: true })}</section>` : ''}
    ${plan.do_now ? focusCard(plan.do_now, s, ui) : ''}
    ${disclosure('today:save', 'Save & reminders', html`
      <div class="save-actions">
        <h3 class="heading small">Save your plan</h3>
        ${plan.reasoning.answer ? html`<p class="secondary-text">Add the event you discussed.</p>` : ''}
        <div class="button-row">
          <button type="button" class="btn-secondary" data-action="sheet" data-sheet="calendar">${i('calendarPlus', 16)}Add to Calendar</button>
          <button type="button" class="btn-secondary" data-action="sheet" data-sheet="reminders">${i('bell', 16)}Reminders</button>
        </div>
      </div>`, { symbol: 'download' })}
    ${warnings.length ? disclosure('today:risks', `${warnings.length} risk alert${warnings.length === 1 ? '' : 's'}`, html`${warnings.map((w) => html`<p class="warning-text small-label top">${i('warning', 13)}${w.text}</p>`)}`, { symbol: 'warning', cls: 'warning' }) : ''}
    ${plan.reasoning.answer ? disclosure('today:notes', 'Plan notes', html`<p class="secondary-text">${plan.reasoning.answer}</p>`) : ''}
    ${renderTimeline(plan, { highlighted: s.highlighted, preset: s.availablePreset, presets: PRESETS, busy: s.pipState === 'thinking' })}
    ${plan.can_wait.length ? canWaitList(plan, s) : ''}
    ${followUpBar(s, ui)}
  </div>`;
}

export { planTag };
