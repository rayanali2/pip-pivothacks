// Port of ios/Pip/Pip/Views/TaskDetailView.swift.

import { html } from '../dom.js';
import { categoryLabel, CURVE_LABELS, dayTime, dollars, parse, windowMinutes } from '../format.js';
import { costChart, disclosure, flagPill, i, pill, taskGlyph } from '../components.js';

const EVIDENCE_LABEL = {
  irreversible_loss: 'Deadline & money', fixed_block_collision: 'Class overlap', basic_needs: 'Basic needs',
  fits_window: 'Time fit', academic_deadline: 'Academic deadline',
};

const FACT_ICON = { Due: 'calendar', 'Money at risk': 'card', 'Full task': 'timer', 'This block': 'timer', Deferred: 'deferArrow', Category: 'stack' };

export function renderDetail(item, task, planNow, s) {
  const category = task?.category ?? item.category;
  const due = task?.due_at ?? item.due_at;
  const money = task?.money_at_risk ?? item.money_at_risk;
  const est = task?.est_minutes ?? item.est_minutes;
  const block = windowMinutes(item);
  const facts = [
    category ? ['Category', categoryLabel(category)] : null,
    due && dayTime(due) ? ['Due', dayTime(due)] : null,
    money > 0 ? ['Money at risk', dollars(money)] : null,
    est ? ['Full task', `${est} min`] : null,
    block ? ['This block', `${block} min`] : null,
    task?.defer_count > 0 ? ['Deferred', task.defer_count === 1 ? 'once' : `${task.defer_count} times`] : null,
  ].filter(Boolean);
  const dueDate = parse(due);
  const reference = parse(planNow) || new Date();
  const hoursToDue = dueDate ? (dueDate - reference) / 3600000 : null;

  return html`<div class="page detail">
    <header class="toolbar">
      <button type="button" class="back-button" data-action="back" aria-label="Back">${i('chevronLeft', 18)}Back</button>
      <h1 class="nav-title truncate">${item.title}</h1>
      <span class="toolbar-spacer"></span>
    </header>

    <section class="card">
      <div class="row between">${taskGlyph(category, { fixed: item.kind === 'fixed_block', size: 54 })}${flagPill(item.flag)}</div>
      <h2 class="title">${item.title}</h2>
      <p class="body-text">${item.action}</p>
      ${est ? html`<div class="flow">${pill(`${est} min`, { symbol: 'timer' })}</div>` : ''}
      ${disclosure(`detail:why:${item.item_id}`, 'Why this task', html`<p class="secondary-text">${item.why}</p>`, { symbol: 'sparkle', cls: 'flush' })}
    </section>

    ${item.task_id ? html`<section class="detail-actions">
      <div class="button-row">
        <button type="button" class="btn-prominent" data-action="record" data-kind="done" data-item="${item.item_id}">${i('check', 16)}Done</button>
        <button type="button" class="btn-bordered" data-action="record" data-kind="defer" data-item="${item.item_id}">${i('deferArrow', 16)}Defer</button>
        <button type="button" class="btn-bordered danger" data-action="record" data-kind="drop" data-item="${item.item_id}">${i('x', 16)}Drop</button>
      </div>
      ${s.actionMessage ? html`<p class="secondary-text small-label" role="status">${s.actionMessage}</p>` : ''}
    </section>` : ''}

    ${facts.length ? html`<section class="card"><div class="facts">${facts.map(([label, value]) => html`<div class="fact-cell"><span class="secondary-text small-label">${i(FACT_ICON[label] || 'stack', 13)}${label}</span><strong>${value}</strong></div>`)}</div></section>` : ''}

    ${item.evidence?.length ? html`<section class="card">
      <span class="eyebrow">${i('checklist', 11)}Why it’s ranked here</span>
      ${item.evidence.map((e) => html`<div class="evidence ${e.fired ? 'fired' : ''}">
        ${i(e.fired ? 'checkCircle' : 'circleDotted', 18)}
        <span><strong>${EVIDENCE_LABEL[e.rule] || e.label}</strong><span class="secondary-text">${e.detail}</span></span>
        <span class="sr-only">${e.fired ? 'Applies' : 'Doesn’t apply'}</span>
      </div>`)}
    </section>` : ''}

    ${item.curve?.length ? html`<section class="card">
      <span class="eyebrow">${i('chart', 11)}Cost of waiting</span>
      ${item.curve_kind ? pill(`${CURVE_LABELS[item.curve_kind] || 'Curve'} curve`, { symbol: 'chart', tint: 'secondary' }) : ''}
      ${costChart(item.curve, hoursToDue, { tall: true })}
    </section>` : ''}

    ${task ? html`<section class="card">${disclosure(`detail:capture:${item.item_id}`, 'Original capture', html`<p class="secondary-text">${task.raw_text}</p><p class="secondary-text">${task.normalized_text}</p>`, { symbol: 'bubble', cls: 'flush' })}</section>` : ''}
  </div>`;
}
