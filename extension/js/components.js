// Shared pieces: ports of PipDesign/SharedViews/PlanVisuals/DoNowStakesStrip/OverrunPreviewButton/PipelineRevealView.

import { disclosureAttrs, html, raw } from './dom.js';
import { CURVE_LABELS, dollars, parse, smartTime, sourceLabel, windowMinutes } from './format.js';
import { categoryIcon, icon } from './icons.js';

export const i = (name, size = 16, cls = '') => raw(icon(name, size, cls));

export function pill(text, { symbol = null, tint = 'accent' } = {}) {
  return html`<span class="pill ${tint}">${symbol ? i(symbol, 12) : ''}${text}</span>`;
}

export function flagPill(flag) {
  if (flag === 'at_risk') return pill('At risk', { symbol: 'warning', tint: 'danger' });
  if (flag === 'balance_guard') return pill('Basic need', { symbol: 'leaf', tint: 'positive' });
  return '';
}

export function planTag(text, symbol, tint = 'accent') {
  return html`<span class="tag ${tint}">${i(symbol, 13)}${text}</span>`;
}

export function sourceLabelView(source) {
  return html`<span class="source" aria-label="Source: ${sourceLabel(source)}">${i(source === 'snowflake' ? 'snowflake' : 'drive', 12)}${sourceLabel(source)}</span>`;
}

export function statusView(symbol, title, detail, { loading = false } = {}) {
  return html`<div class="status-view" role="status">
    <span class="status-badge">${loading ? raw('<span class="spinner"></span>') : i(symbol, 16)}</span>
    <span class="status-text"><strong>${title}</strong><span>${detail}</span></span>
  </div>`;
}

export function disclosure(key, title, body, { symbol = 'list', cls = '' } = {}) {
  return html`<details class="disclosure ${cls}" ${disclosureAttrs(key)}>
    <summary>${i(symbol, 15)}<span>${title}</span>${i('chevronDown', 14, 'disclosure-chevron')}</summary>
    <div class="disclosure-body">${body}</div>
  </details>`;
}

export function taskGlyph(category, { fixed = false, size = 44 } = {}) {
  return html`<span class="glyph" style="width:${size}px;height:${size}px;border-radius:${size * 0.32}px">${i(fixed ? 'graduation' : categoryIcon(category), Math.round(size * 0.45))}</span>`;
}

export function whatChanged(headline) {
  return html`<div class="what-changed" role="status" data-anim="wc:${headline}">
    <span class="wc-icon">${i('refresh', 14)}</span>
    <span><span class="eyebrow accent">What changed</span><span class="wc-text">${headline}</span></span>
  </div>`;
}

/** "25 / 47 min" bar with spare or over (WindowFitView). */
export function windowFit(used, available, { compact = false } = {}) {
  const fits = used <= available;
  const tint = fits ? 'accent' : 'warning';
  const fraction = Math.min(1, Math.max(0, used / Math.max(1, available)));
  const ring = compact ? '' : html`<span class="fit-ring ${tint}" style="--p:${fraction}">${i(fits ? 'timer' : 'warning', 18)}</span>`;
  return html`<div class="window-fit">
    ${ring}
    <span class="fit-body">
      <span class="fit-line"><strong>${used} / ${available} min</strong><span class="${tint}-text">${fits ? `${available - used} min spare` : `${used - available} min over`}</span></span>
      <span class="progress ${tint}" role="progressbar" aria-valuemin="0" aria-valuemax="${available}" aria-valuenow="${used}"><span style="width:${fraction * 100}%"></span></span>
    </span>
  </div>`;
}

export function taskMetadata(item, now) {
  const minutes = windowMinutes(item);
  const due = smartTime(item.due_at, now);
  const tags = [
    minutes ? planTag(`${minutes} min`, 'timer') : '',
    due ? planTag(`Due ${due}`, 'calendar') : '',
    item.money_at_risk > 0 ? planTag(`${dollars(item.money_at_risk)} at risk`, 'warning', 'warning') : '',
  ];
  return html`<div class="flow">${tags}</div>`;
}

// MARK: Stakes strip

const RULE_SHORT = { irreversible_loss: 'Loss', fixed_block_collision: 'Class clash', basic_needs: 'Basics', fits_window: 'Fits now', academic_deadline: 'Deadline' };

/** Countdown text: "$79 refund gone in 3h 46m · 5:00 PM", "Due in 1d 10h · Tue 11:59 PM", "Past due". */
export function countdownText(item, planNow, remainingMs) {
  const dueTime = smartTime(item.due_at, planNow);
  let lead;
  if (remainingMs <= 0) lead = 'Past due';
  else {
    const money = item.money_at_risk > 0 ? dollars(item.money_at_risk) : null;
    const refund = /refund|return/i.test(item.title);
    const stake = money ? (refund ? `${money} refund gone` : `${money} at risk`) : null;
    lead = stake ? `${stake} in ${compactDuration(remainingMs)}` : `Due in ${compactDuration(remainingMs)}`;
  }
  return dueTime ? `${lead} · ${dueTime}` : lead;
}

function compactDuration(ms) {
  const total = Math.floor(Math.min(Math.max(ms, 0), 1e12) / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (total < 600) return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Area + line over hours of postponement, deadline dashed. `tall` is the detail-page chart. */
export function costChart(points, hoursToDue, { tall = false } = {}) {
  if (!points?.length) return '';
  const w = 300;
  const h = tall ? 170 : 44;
  const pad = tall ? { l: 30, r: 8, t: 16, b: 22 } : { l: 1, r: 1, t: 3, b: 3 };
  const xs = points.map((p) => p.hours);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const x = (v) => pad.l + ((v - min) / Math.max(1e-6, max - min)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - Math.min(1, Math.max(0, v))) * (h - pad.t - pad.b);
  const line = points.map((p, idx) => `${idx ? 'L' : 'M'}${x(p.hours).toFixed(1)} ${y(p.cost).toFixed(1)}`).join(' ');
  const area = `${line} L${x(max).toFixed(1)} ${h - pad.b} L${x(min).toFixed(1)} ${h - pad.b} Z`;
  const due = hoursToDue != null && hoursToDue >= min && hoursToDue <= max ? x(hoursToDue) : null;
  const axis = tall ? `
    <line x1="${pad.l}" y1="${h - pad.b}" x2="${w - pad.r}" y2="${h - pad.b}" class="axis"/>
    <text x="${pad.l - 6}" y="${y(1) + 4}" text-anchor="end" class="axis-text">1</text>
    <text x="${pad.l - 6}" y="${y(0) + 4}" text-anchor="end" class="axis-text">0</text>
    <text x="${pad.l}" y="${h - 6}" class="axis-text">${min}h</text>
    <text x="${w - pad.r}" y="${h - 6}" text-anchor="end" class="axis-text">${max}h from now</text>` : '';
  const dueMark = due == null ? '' : `<line x1="${due}" y1="${pad.t}" x2="${due}" y2="${h - pad.b}" class="due-line ${tall ? 'danger' : ''}"/>${tall ? `<text x="${due + 3}" y="${pad.t - 4}" class="due-text">Due</text>` : ''}`;
  return raw(`<svg class="cost-chart ${tall ? 'tall' : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Cost of waiting">${axis}<path d="${area}" class="area"/><path d="${line}" class="line"/>${dueMark}</svg>`);
}

export function stakesStrip(item, planNow, { expandedRule, key }) {
  const due = parse(item.due_at);
  const reference = parse(planNow);
  const hoursToDue = due && reference ? (due - reference) / 3600000 : null;
  const fired = (item.evidence || []).filter((e) => e.fired).length;
  const expanded = expandedRule != null ? item.evidence?.[expandedRule] : null;
  return html`<div class="stakes">
    ${due ? html`<p class="countdown" data-countdown data-due="${item.due_at}" data-plan-now="${planNow}" data-item-title="${item.title}" data-money="${item.money_at_risk ?? ''}">${i('hourglass', 13)}<span></span></p>` : ''}
    ${item.curve?.length ? html`<div class="sparkline">
      <span class="eyebrow">Cost of waiting <span class="eyebrow-plain">${CURVE_LABELS[item.curve_kind] || 'Curve'}</span></span>
      ${costChart(item.curve, hoursToDue)}
    </div>` : ''}
    ${item.evidence?.length ? html`<div class="rules">
      <span class="eyebrow" aria-label="${fired} of ${item.evidence.length} rules fired">Rules · ${fired} of ${item.evidence.length} fired</span>
      <div class="rule-chips">${item.evidence.map((e, idx) => html`<button type="button" class="rule-chip ${e.fired ? 'fired' : ''} ${expandedRule === idx ? 'expanded' : ''}" data-action="rule" data-key="${key}" data-index="${idx}" aria-pressed="${expandedRule === idx}" aria-label="${RULE_SHORT[e.rule] || e.label} rule, ${e.fired ? 'fired' : 'not fired'}">${e.fired ? i('check', 11) : ''}${RULE_SHORT[e.rule] || e.label}</button>`)}</div>
      ${expanded ? html`<p class="rule-detail" data-anim="rule:${key}:${expandedRule}">${i(expanded.fired ? 'checkCircle' : 'circleDotted', 14, expanded.fired ? 'accent-text' : '')}<span>${expanded.detail}</span></p>` : ''}
    </div>` : ''}
  </div>`;
}

/** Fills and ticks every countdown on screen, once a second. */
export function tickCountdowns(root, nowFor) {
  root.querySelectorAll('[data-countdown]').forEach((el) => {
    const due = parse(el.dataset.due);
    if (!due) return;
    const remaining = due - nowFor(el.dataset.planNow);
    const item = { due_at: el.dataset.due, title: el.dataset.itemTitle, money_at_risk: el.dataset.money === '' ? null : Number(el.dataset.money) };
    el.querySelector('span').textContent = countdownText(item, el.dataset.planNow, remaining);
    el.classList.toggle('warning-text', remaining < 2 * 3600000);
  });
}

// MARK: Overrun preview

export function overrunPreview(item, s) {
  const plan = s.currentPlan;
  const available = item.kind === 'task' && !s.isOffline && plan && plan.reasoning.effective_minutes > 0
    && [plan.do_now, plan.next, ...plan.today, ...plan.can_wait].some((x) => x?.item_id === item.item_id);
  if (!available) return '';
  const preview = s.overrunPreview?.itemId === item.item_id ? s.overrunPreview : null;
  return html`<div class="overrun">
    <button type="button" class="link-button" data-action="overrun" data-item="${item.item_id}" ${s.overrunLoading || s.pipState === 'thinking' ? raw('disabled') : ''}>
      ${s.overrunLoading ? raw('<span class="spinner small"></span>') : ''}What if this takes 10 min longer?
    </button>
    ${preview ? html`<div class="overrun-card" role="status" data-anim="overrun:${preview.headline}">
      <strong>${i('clockAlert', 15, 'accent-text')}${preview.headline}</strong>
      ${preview.changed ? html`<span>Do now would be: ${preview.doNowTitle || 'nothing fits'}</span>` : ''}
      <small>Preview only · your plan is unchanged</small>
    </div>` : ''}
  </div>`;
}

// MARK: Pipeline reveal

const PENDING = ['Listening back', 'Finding tasks', 'Weighing 5 rules', 'Writing your plan'];
const PENDING_BY_ID = { transcribe: PENDING[0], extract: PENDING[1], rank: PENDING[2], wording: PENDING[3] };
const CHIP_ICON = { task: 'checklist', fixed_block: 'lock', cash: 'dollar', time_window: 'clock', travel: 'walk', question: 'question' };

function engineIcon(engine) {
  if (engine.startsWith('Snowflake')) return 'snowflake';
  if (engine.startsWith('Claude')) return 'sparkle';
  return null;
}

const duration = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function pipelineReveal(stages, revealed) {
  const pending = (label, active) => html`<div class="stage pending ${active ? 'active' : ''}">
    <span class="stage-icon">${active ? raw('<span class="spinner small"></span>') : raw('<span class="ring"></span>')}</span><span>${label}</span></div>`;
  const rows = !stages.length
    ? PENDING.map((label, idx) => pending(label, idx === 0))
    : stages.map((stage, idx) => {
      if (idx >= revealed) return pending(PENDING_BY_ID[stage.id] || stage.label, idx === revealed);
      const status = stage.status === 'ok' ? 'positive' : stage.status === 'fallback' ? 'warning' : 'secondary';
      const symbol = stage.status === 'ok' ? 'check' : stage.status === 'fallback' ? 'undo' : 'minus';
      const eng = engineIcon(stage.engine || '');
      return html`<div class="stage revealed" data-anim="stage:${stage.id}:${stage.label}:${stage.detail}">
        <span class="stage-icon ${status}">${i(symbol, 12)}</span>
        <span class="stage-body">
          <span class="stage-line"><strong>${stage.label}</strong>${stage.ms != null ? html`<span class="stage-ms">${duration(stage.ms)}</span>` : ''}</span>
          ${stage.engine ? html`<span class="engine">${eng ? i(eng, 11) : ''}${stage.engine}</span>` : ''}
          ${stage.detail ? html`<span class="stage-detail">${stage.detail}</span>` : ''}
          ${stage.chips?.length ? html`<span class="chips">${stage.chips.map((c, n) => html`<span class="chip pop" style="animation-delay:${100 + n * 70}ms">${i(CHIP_ICON[c.kind] || 'tag', 11, 'accent-text')}${c.label}</span>`)}</span>` : ''}
        </span>
      </div>`;
    });
  return html`<section class="card pipeline" aria-live="polite"><span class="eyebrow wide">Pip is working</span>${rows}</section>`;
}
