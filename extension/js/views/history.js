// Port of ios/Pip/Pip/Views/HistoryView.swift: decisions (with an actions filter) and, in demo mode, the Pivot Log.

import { config } from '../api.js';
import { disclosureAttrs, html } from '../dom.js';
import { ACTION_PAST, dayTime, dollars, parse, time } from '../format.js';
import { i, planTag, statusView } from '../components.js';

function decisionRow(entry) {
  const rerank = entry.trigger === 'rerank';
  const question = entry.context?.question;
  const quote = rerank ? (question || entry.transcript) : (entry.transcript || question);
  const last = entry.actions[entry.actions.length - 1];
  return html`<article class="decision">
    <span class="decision-icon">${i(rerank ? 'refresh' : 'bubble', 16)}</span>
    <span class="grow">
      <span class="row between"><span class="eyebrow accent">${rerank ? 'Plan updated' : 'Plan created'}</span><small class="secondary-text">${dayTime(entry.created_at) || entry.created_at}</small></span>
      <strong class="decision-title">${entry.do_now_title || 'Plan saved'}</strong>
      ${entry.context?.available_minutes != null ? planTag(`${entry.context.available_minutes} min available`, 'timer') : ''}
      ${last ? html`<span class="small-label ${last.kind === 'done' || last.kind === 'start_now' ? 'positive-text' : 'secondary-text'}">${i(last.kind === 'drop' ? 'xCircle' : 'checkCircle', 13)}${ACTION_PAST[last.kind] || 'Action'}</span>` : ''}
      <details class="disclosure mini" ${disclosureAttrs(`history:${entry.plan_id}`)}>
        <summary><span>Decision details</span>${i('chevronDown', 12, 'disclosure-chevron')}</summary>
        <div class="disclosure-body secondary-text">
          ${quote ? html`<p class="ink">“${quote}”</p>` : ''}
          ${entry.context?.cash_available != null ? html`<p class="small-label">${i('card', 13)}${dollars(entry.context.cash_available)}</p>` : ''}
          <p>${entry.changed}</p>
          ${entry.actions.map((a) => html`<p>${ACTION_PAST[a.kind] || 'Action'}${a.task_title ? `: ${a.task_title}` : ''}${time(a.created_at) ? ` · ${time(a.created_at)}` : ''}</p>`)}
        </div>
      </details>
    </span>
  </article>`;
}

function pivotRow(entry) {
  const field = (label, text) => html`<div class="pivot-field"><span class="eyebrow">${label}</span><p>${text}</p></div>`;
  return html`<article class="pivot">
    <span class="pivot-mark"></span>
    <span class="grow">
      <strong class="decision-title">Pivot ${entry.pivot_number}</strong>
      <details class="disclosure mini" ${disclosureAttrs(`pivot:${entry.entry_id}`)}>
        <summary><span>Explore pivot</span>${i('chevronDown', 12, 'disclosure-chevron')}</summary>
        <div class="disclosure-body">
          ${field('Revealed', entry.revealed)}${field('Assumption changed', entry.assumption_changed)}${field('Response', entry.response)}${field('Cut', entry.cut)}
          ${entry.sentence ? html`<p class="secondary-text"><em>${entry.sentence}</em></p>` : ''}
        </div>
      </details>
    </span>
  </article>`;
}

export function renderHistory(s, ui) {
  const pivots = ui.historyMode === 'pivots' && config.demoMode;
  const actionsCount = s.history.reduce((sum, e) => sum + e.actions.length, 0);
  const sorted = s.history
    .filter((e) => !ui.actionsOnly || e.actions.length)
    .sort((a, b) => (parse(b.created_at) || 0) - (parse(a.created_at) || 0));

  let body;
  if (pivots) {
    body = s.pivotLog.length
      ? [...s.pivotLog].sort((a, b) => a.pivot_number - b.pivot_number).map(pivotRow)
      : html`<div class="form-row">${statusView('branch', 'No pivots yet', 'Logged pivots show up here.')}</div>`;
  } else {
    body = sorted.length
      ? sorted.map(decisionRow)
      : html`<div class="form-row">${statusView('history', ui.actionsOnly ? 'No actions yet' : 'No decisions yet', ui.actionsOnly ? 'Tap Start now on a task.' : 'Talk to Pip to make your first plan.')}</div>`;
  }

  return html`<div class="page history">
    <header class="toolbar">
      <button type="button" class="icon-button plain" data-action="history-refresh" aria-label="Refresh history">${i('refresh', 18)}</button>
      <h1 class="nav-title">${pivots ? 'Pivot Log' : 'History'}</h1>
      ${config.demoMode ? html`<button type="button" class="link-button strong" data-action="history-mode">${pivots ? 'Decisions' : 'Pivot Log'}</button>` : html`<span class="toolbar-spacer"></span>`}
    </header>
    <div class="row gap">
      <button type="button" class="tag-button" data-action="history-all">${planTag(`${s.history.length} decisions`, 'stack')}</button>
      <button type="button" class="tag-button" data-action="history-actions" aria-pressed="${ui.actionsOnly}">${planTag(`${actionsCount} actions`, ui.actionsOnly ? 'checkCircle' : 'checkCircle', 'positive')}</button>
    </div>
    <div class="form-card list">${body}</div>
  </div>`;
}
