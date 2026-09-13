// Port of ios/Pip/Pip/Views/ScheduleView.swift: today's fixed and flexible blocks, the week,
// money & routine, and the server connection.

import { config } from '../api.js';
import { disclosureAttrs, html, raw } from '../dom.js';
import { CATEGORY_LABELS, CHRONOTYPE_LABELS, categoryLabel, freeWindowText, opensDetail, time, timeOfDay, timeRange, weekdayName, windowMinutes } from '../format.js';
import { flagPill, i, pill, planTag, statusView } from '../components.js';
import { categoryIcon } from '../icons.js';

function flexibleItems(plan) {
  if (!plan) return [];
  return [plan.do_now, plan.next, ...plan.today].filter((x) => x && x.kind !== 'fixed_block');
}

function blockRow(block) {
  return html`<details class="schedule-row" ${disclosureAttrs(`block:${block.day_of_week}:${block.starts_at}:${block.title}`)}>
    <summary>
      <span class="time-col"><strong class="mono">${timeOfDay(block.starts_at)}</strong><small class="mono secondary-text">${timeOfDay(block.ends_at)}</small></span>
      <span class="rail fixed"></span>
      <span class="grow"><strong>${block.title}</strong><span class="flow">${pill('Class', { symbol: 'lock' })}</span></span>
      ${i('chevronDown', 14, 'disclosure-chevron')}
    </summary>
    <p class="secondary-text small-label schedule-extra">${i('pin', 13)}${block.location || 'No location added'}</p>
  </details>`;
}

function taskRow(item) {
  const minutes = windowMinutes(item);
  return html`<button type="button" class="schedule-row task" data-action="open-detail" data-item="${item.item_id}">
    <span class="time-col"><strong class="mono">${time(item.starts_at) || 'Anytime'}</strong>${time(item.ends_at) ? html`<small class="mono secondary-text">${time(item.ends_at)}</small>` : ''}</span>
    <span class="rail flexible"></span>
    <span class="grow">
      <strong>${item.title}</strong>
      <span class="flow">
        ${pill('Flexible', { symbol: 'circleDotted', tint: 'secondary' })}
        ${item.category ? pill(categoryLabel(item.category), { symbol: categoryIcon(item.category), tint: 'secondary' }) : ''}
        ${minutes ? pill(`${minutes} min`, { symbol: 'timer', tint: 'secondary' }) : ''}
        ${flagPill(item.flag)}
      </span>
      <span class="secondary-text clamp-2">${item.action}</span>
    </span>
    ${i('chevronRight', 14, 'chevron')}
  </button>`;
}

function healthRows(s) {
  const h = s.health;
  if (!h && !s.isOffline) return '';
  const mode = s.isOffline ? 'Unavailable' : h.mode.charAt(0).toUpperCase() + h.mode.slice(1);
  const snowflake = s.isOffline ? 'Not reachable' : h.snowflake.connected ? 'Connected' : h.snowflake.configured ? 'Configured, not connected' : 'Not configured';
  const cortex = h ? [h.cortex.complete, h.cortex.complete_model].filter(Boolean).join(' · ') || 'Not verified' : 'Not verified';
  return html`
    <div class="form-row labeled"><span>Mode</span><span class="secondary-text">${mode}</span></div>
    <div class="form-row labeled"><span>Snowflake</span><span class="secondary-text">${snowflake}</span></div>
    <div class="form-row labeled"><span>Cortex</span><span class="secondary-text">${cortex}</span></div>
    ${h?.cortex.transcribe ? html`<div class="form-row labeled"><span>Transcribe</span><span class="secondary-text">${h.cortex.transcribe}</span></div>` : ''}
    ${h?.snowflake.error && !s.isOffline ? html`<p class="form-row danger-text small">${h.snowflake.error}</p>` : ''}`;
}

export function renderSchedule(s, ui) {
  const plan = s.currentPlan;
  const filter = ui.scheduleFilter;
  const todayBlocks = [...(s.todayTimetable?.blocks || [])].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const flexible = flexibleItems(plan);
  const entries = [
    ...todayBlocks.map((block) => ({ id: `class-${block.starts_at}-${block.title}`, time: block.starts_at, block })),
    ...flexible.filter((item) => item.starts_at?.length >= 16).map((item) => ({ id: item.item_id, time: item.starts_at.slice(11, 16), item })),
  ]
    .filter((e) => filter === 'all' || (filter === 'fixed' ? e.block : e.item))
    .sort((a, b) => (a.time === b.time ? a.id.localeCompare(b.id) : a.time.localeCompare(b.time)));
  const unscheduled = flexible.filter((item) => !item.starts_at);
  const windowLabel = freeWindowText(plan) || s.todayTimetable?.next_free_window?.label;
  const profile = s.profile;
  const busy = ui.profileSaving;

  return html`<div class="page schedule">
    <header class="toolbar">
      <span class="toolbar-spacer"></span>
      <h1 class="nav-title">Schedule</h1>
      <button type="button" class="icon-button plain" data-action="sheet" data-sheet="addBlock" aria-label="Add block">${i('plus', 20)}</button>
    </header>

    <div class="row gap">
      <button type="button" class="tag-button" data-action="schedule-filter" data-filter="fixed" aria-pressed="${filter === 'fixed'}">${planTag(`${todayBlocks.length} fixed`, filter === 'fixed' ? 'lock' : 'lock')}</button>
      <button type="button" class="tag-button" data-action="schedule-filter" data-filter="flexible" aria-pressed="${filter === 'flexible'}">${planTag(`${flexible.length} flexible`, filter === 'flexible' ? 'checkCircle' : 'circleDotted')}</button>
    </div>

    <section class="form-section">
      <h3 class="section-title">${filter === 'all' ? 'Today' : filter === 'fixed' ? 'Fixed only · tap chip to clear' : 'Flexible only · tap chip to clear'}</h3>
      <div class="form-card">
        ${windowLabel ? html`<p class="form-row accent-text strong">${i('hourglass', 14)}${windowLabel}</p>` : ''}
        ${entries.length ? entries.map((e) => (e.block ? blockRow(e.block) : taskRow(e.item))) : html`<div class="form-row">${statusView('calendar', 'Nothing scheduled today', 'Tap + to add a class.')}</div>`}
      </div>
      <p class="footnote">Classes are fixed. Task times are suggestions.</p>
    </section>

    ${unscheduled.length && filter !== 'fixed' ? html`<section class="form-section">
      <h3 class="section-title">No time yet</h3>
      <div class="form-card">${unscheduled.map((item) => html`<button type="button" class="form-button stacked" ${opensDetail(item) ? raw(`data-action="open-detail" data-item="${item.item_id}"`) : raw('disabled')}>
        <strong>${item.title}</strong><span class="secondary-text clamp-2">${item.action}</span>${flagPill(item.flag)}
      </button>`)}</div>
    </section>` : ''}

    <section class="form-section">
      <h3 class="section-title">Week</h3>
      <div class="form-card"><button type="button" class="form-button strong accent-text" data-action="sheet" data-sheet="addBlock">${i('plusCircle', 16)}Add block</button></div>
    </section>
    ${[1, 2, 3, 4, 5, 6, 7].map((day) => {
      const blocks = s.weekTimetable.filter((b) => b.day_of_week === day).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      if (!blocks.length) return '';
      return html`<section class="form-section">
        <h3 class="section-title">${weekdayName(day)}</h3>
        <div class="form-card">${blocks.map((b) => html`<div class="form-row week-row">
          <span class="grow"><strong class="medium">${b.title}</strong><small class="mono secondary-text">${timeRange(b.starts_at, b.ends_at)}${b.location ? ` · ${b.location}` : ''}</small></span>
          <button type="button" class="mini-button danger" data-action="block-delete" data-day="${day}" data-start="${b.starts_at}" data-title="${b.title}" aria-label="Delete ${b.title}">${i('trash', 14)}</button>
        </div>`)}</div>
      </section>`;
    })}

    <section class="form-section">
      <h3 class="section-title">Money &amp; routine</h3>
      <form class="form-card" data-form="profile">
        <label class="form-row labeled"><span>Cash available</span><span class="money-input">$<input id="profile-cash" type="number" min="0" max="1000000" step="0.01" inputmode="decimal" value="${profile ? profile.cash_available : ''}" placeholder="0"></span></label>
        <label class="form-row labeled"><span>Budget until</span><input id="profile-until" type="date" value="${profile?.budget_until || ''}"></label>
        <label class="form-row labeled toggle-row"><span>Cooks own meals</span><input id="profile-cooks" type="checkbox" class="switch" ${profile?.cooks_own_meals !== false ? raw('checked') : ''}></label>
        <label class="form-row labeled"><span>Peak energy</span><select id="profile-chronotype">${Object.entries(CHRONOTYPE_LABELS).map(([value, label]) => html`<option value="${value}" ${(profile?.chronotype || 'neutral') === value ? raw('selected') : ''}>${label}</option>`)}</select></label>
        <label class="form-row labeled"><span>Procrastinates on</span><select id="profile-procrastinates"><option value="">Nothing</option>${Object.entries(CATEGORY_LABELS).map(([value, label]) => html`<option value="${value}" ${profile?.procrastinates_on === value ? raw('selected') : ''}>${label}</option>`)}</select></label>
        <button type="submit" class="form-button strong" ${busy ? raw('disabled') : ''}><span class="grow">Save</span>${busy ? raw('<span class="spinner small"></span>') : ui.profileSaved ? html`<span class="positive-text small-label">${i('check', 13)}Saved</span>` : ''}</button>
      </form>
    </section>

    <section class="form-section">
      <h3 class="section-title">Server</h3>
      <form class="form-card" data-form="server">
        <label class="form-row"><input id="server-url" type="url" value="${config.base}" placeholder="http://localhost:3000" aria-label="Server address" autocomplete="off" spellcheck="false"></label>
        <button type="submit" class="form-button" ${s.testingConnection ? raw('disabled') : ''}><span class="grow">Test connection</span>${s.testingConnection ? raw('<span class="spinner small"></span>') : ''}</button>
        ${s.connectionStatus ? html`<p class="form-row secondary-text small">${s.connectionStatus}</p>` : ''}
        ${healthRows(s)}
        <label class="form-row labeled toggle-row"><span>Developer demo<small class="secondary-text block">Shared demo student and demo tools</small></span><input type="checkbox" class="switch" data-action-change="demo-mode" ${config.demoMode ? raw('checked') : ''}></label>
        ${config.demoMode ? html`<button type="button" class="form-button danger-text" data-action="reset-demo">Reset demo data</button>` : ''}
      </form>
      <p class="footnote">Keep the API running on this computer (npm run dev). A server connection is required to save your input and update plans.</p>
    </section>
  </div>`;
}
