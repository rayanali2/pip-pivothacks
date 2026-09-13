// Port of ios/Pip/Pip/Views/Timeline (TimelineLayout + DayTimelineView + rows).
// The day under a Now line: timed items at their slots (1.1 px per minute), long empty stretches
// collapsed into "2 h 15 min free", items without a clock time in a tray at the top.

import { html, raw } from './dom.js';
import { categoryLabel, dollars, durationText, opensDetail, parse, smartTime, time, timeOfDay } from './format.js';
import { categoryIcon, icon } from './icons.js';

const M = { perMinute: 1.1, collapseGap: 75, gapRow: 30, spacing: 8, doNowMin: 80, cardMin: 76, markerMin: 52, minTick: 22 };
const SLOT_GAP_MINUTES = 15;

const firstInteger = (text) => { const m = /\d+/.exec(text || ''); return m ? Number(m[0]) : null; };

export function firstStepMinutes(item, plan) {
  if (item.task_id) {
    const entry = (plan.reasoning.pre_rank || []).find((p) => p.task_id === item.task_id);
    if (entry?.first_step_minutes > 0) return entry.first_step_minutes;
  }
  const detail = (item.evidence || []).find((e) => e.rule === 'fits_window')?.detail;
  const minutes = firstInteger(detail);
  if (minutes > 0) return minutes;
  return item.est_minutes;
}

function rangeText(startIso, endIso, planNow) {
  if (!startIso || !endIso) return null;
  const startText = smartTime(startIso, planNow);
  const endText = time(endIso);
  if (!startText || !endText) return null;
  const range = rangeOfDay(startIso.slice(11, 16), endIso.slice(11, 16));
  if (startText === time(startIso)) return range;
  return `${startText.split(' ')[0]} ${range}`;
}

function rangeOfDay(start, end) {
  const [sh] = start.split(':').map(Number);
  const [eh] = end.split(':').map(Number);
  const s = timeOfDay(start);
  const e = timeOfDay(end);
  return (sh < 12) === (eh < 12) ? `${s.replace(/ (AM|PM)$/, '')}–${e}` : `${s}–${e}`;
}

const styleFor = (item) => (item.kind === 'fixed_block' ? 'fixedBlock' : item.item_id.endsWith('#cont') ? 'continuation' : 'task');
const minHeight = (style) => (style === 'doNow' ? M.doNowMin : style === 'marker' ? M.markerMin : M.cardMin);
const laterDate = (date, start) => (date && date > start ? date : null);

function sortItems(plan, origin) {
  const planNow = plan.reasoning.now;
  const slots = [];
  const tray = [];
  const seen = new Set();
  let doNowEnd = null;
  const doNow = plan.do_now;
  if (doNow) {
    const start = parse(doNow.starts_at) || origin;
    if (start) {
      seen.add(doNow.item_id);
      const minutes = firstStepMinutes(doNow, plan) ?? 15;
      const end = laterDate(parse(doNow.ends_at), start) || new Date(start.getTime() + minutes * 60000);
      const clock = smartTime(doNow.starts_at, planNow) || 'Now';
      const text = rangeText(doNow.starts_at, doNow.ends_at, planNow) || `${clock} · ~${minutes} min`;
      slots.push({ item: doNow, style: 'doNow', start, end, text, order: 0 });
      doNowEnd = end;
    }
  }
  const others = [plan.next, ...(plan.today || [])].filter(Boolean);
  others.forEach((item, index) => {
    if (seen.has(item.item_id)) return;
    seen.add(item.item_id);
    const order = index + 1;
    const start = parse(item.starts_at);
    if (start) {
      const end = laterDate(parse(item.ends_at), start);
      if (end) {
        const text = rangeText(item.starts_at, item.ends_at, planNow) || smartTime(item.starts_at, planNow) || '';
        slots.push({ item, style: styleFor(item), start, end, text, order });
      } else {
        slots.push({ item, style: 'marker', start, end: null, text: smartTime(item.starts_at, planNow) || '', order });
      }
    } else if (item.flag === 'at_risk') {
      tray.push({ item, reason: { kind: 'atRisk', needed: firstStepMinutes(item, plan), available: plan.reasoning.effective_minutes } });
    } else if (item.item_id === plan.next?.item_id && item.kind !== 'fixed_block' && (doNowEnd || origin)) {
      const minutes = firstStepMinutes(item, plan) ?? 15;
      const anchor = doNowEnd || origin;
      const s = new Date(anchor.getTime() + (doNowEnd ? SLOT_GAP_MINUTES * 60000 : 0));
      slots.push({ item, style: 'task', start: s, end: new Date(s.getTime() + minutes * 60000), text: `Then · ~${minutes} min`, order });
    } else {
      tray.push({ item, reason: { kind: 'needsGap', minutes: item.est_minutes ?? firstStepMinutes(item, plan) } });
    }
  });
  return { slots, tray };
}

/** Pure layout, same numbers as TimelineLayout.make. */
export function layoutTimeline(plan) {
  const planNow = plan.reasoning.now;
  const nowText = time(planNow) || 'Now';
  const origin = parse(planNow);
  const { slots, tray } = sortItems(plan, origin);
  const start = origin || (slots.length ? new Date(Math.min(...slots.map((s) => s.start))) : null);
  if (!start) return { nowText, tray, rows: [], height: 0 };

  const ordered = [...slots].sort((a, b) => (a.start - b.start) || (a.order - b.order));
  const rows = [];
  const segments = [];
  let cursorTime = start;
  let cursorY = 0;

  for (const slot of ordered) {
    const slotStart = slot.start > start ? slot.start : start;
    const gapMinutes = (slotStart - cursorTime) / 60000;
    let y;
    if (gapMinutes > M.collapseGap) {
      const gapY = rows.length ? cursorY + M.spacing : 0;
      rows.push({ type: 'gap', id: `gap-${cursorTime.getTime()}`, label: `${durationText(Math.round(gapMinutes))} free`, y: gapY, height: M.gapRow });
      y = gapY + M.gapRow + M.spacing;
    } else {
      const timeY = cursorY + Math.max(0, gapMinutes) * M.perMinute;
      y = rows.length ? Math.max(timeY, cursorY + M.spacing) : timeY;
      if (gapMinutes > 0) segments.push({ from: cursorTime, to: slotStart, top: cursorY, bottom: y });
    }
    let height;
    if (slot.style === 'marker') height = M.markerMin;
    else {
      const slotEnd = slot.end && slot.end > slotStart ? slot.end : slotStart;
      const minutes = (slotEnd - slotStart) / 60000;
      height = Math.max(minHeight(slot.style), minutes * M.perMinute);
      if (minutes > 0) segments.push({ from: slotStart, to: slotEnd, top: y, bottom: y + height });
    }
    rows.push({ type: 'entry', id: slot.item.item_id, item: slot.item, style: slot.style, text: slot.text, y, height });
    cursorY = Math.max(cursorY, y + height);
    const endTime = slot.end || slotStart;
    if (endTime > cursorTime) cursorTime = endTime;
  }

  const end = ordered.reduce((max, s) => ((s.end || s.start) > max ? (s.end || s.start) : max), start);
  const ticks = hourTicks(start, end, segments, planNow);
  const rank = { entry: 0, gap: 1, tick: 2 };
  const all = [...rows, ...ticks].sort((a, b) => (a.y - b.y) || (rank[a.type] - rank[b.type]));
  return { nowText, tray, rows: all, height: cursorY };
}

/** Hour labels in the plan's own offset, placed on the stretch of timeline that contains them. */
function hourTicks(start, end, segments, planNow) {
  const offsetMatch = /([+-])(\d{2}):(\d{2})$/.exec(planNow || '');
  const offsetMinutes = offsetMatch ? (offsetMatch[1] === '-' ? -1 : 1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) : -start.getTimezoneOffset();
  const wallMs = start.getTime() + offsetMinutes * 60000;
  let hour = new Date(Math.ceil((wallMs + 1) / 3600000) * 3600000 - offsetMinutes * 60000);
  const ticks = [];
  let lastY = null;
  for (let steps = 0; hour <= end && steps < 96; steps += 1) {
    const segment = segments.find((s) => s.from <= hour && hour <= s.to);
    if (segment) {
      const span = segment.to - segment.from;
      const y = span > 0 ? segment.top + (segment.bottom - segment.top) * ((hour - segment.from) / span) : segment.top;
      if (y >= M.minTick / 2 && (lastY == null || y - lastY >= M.minTick)) {
        const h = new Date(hour.getTime() + offsetMinutes * 60000).getUTCHours();
        ticks.push({ type: 'tick', id: `tick-${hour.getTime()}`, label: `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`, y });
        lastY = y;
      }
    }
    hour = new Date(hour.getTime() + 3600000);
  }
  return ticks;
}

// MARK: Render

const EYEBROW = { doNow: 'NOW', fixedBlock: 'FIXED CLASS', continuation: 'CONTINUED' };
const SYMBOL = { doNow: 'sparkle', fixedBlock: 'lock', continuation: 'arrowTurn' };

function flagPill(flag) {
  if (!flag) return '';
  const tint = flag === 'at_risk' ? 'danger' : 'positive';
  return html`<span class="pill ${tint}">${raw(icon(flag === 'at_risk' ? 'warning' : 'leaf', 12))}${flag === 'at_risk' ? 'At risk' : 'Basic need'}</span>`;
}

function wrapDetail(item, inner, flipId) {
  if (opensDetail(item)) {
    return html`<button type="button" class="tl-link" data-flip="${flipId}" data-action="open-detail" data-item="${item.item_id}">${inner}</button>`;
  }
  return html`<div class="tl-static" data-flip="${flipId}">${inner}</div>`;
}

function entryCard(row, highlighted) {
  const { item, style } = row;
  const chevron = opensDetail(item) ? raw(icon('chevronRight', 14, 'chevron')) : '';
  if (style === 'marker') {
    const inner = html`<div class="tl-card marker ${highlighted ? 'highlight' : ''}" style="min-height:${row.height}px">
      <span class="tl-icon round">${raw(icon(item.category === 'rest' ? 'moon' : 'clock', 16))}</span>
      <span class="tl-body"><span class="tl-title">${item.title}</span><span class="tl-time">${row.text}</span></span>
      ${flagPill(item.flag)}${chevron}</div>`;
    return wrapDetail(item, inner, item.item_id);
  }
  const symbol = SYMBOL[style] || categoryIcon(item.category);
  const eyebrow = EYEBROW[style] || categoryLabel(item.category).toUpperCase();
  const inner = html`<div class="tl-card ${style} ${highlighted ? 'highlight' : ''}" style="min-height:${row.height}px">
    <span class="tl-icon">${raw(icon(symbol, 16))}</span>
    <span class="tl-body">
      <span class="tl-eyebrow">${eyebrow}</span>
      <span class="tl-title">${item.title}</span>
      <span class="tl-time">${row.text}</span>
      ${style === 'fixedBlock' && item.location ? html`<span class="tl-location">${raw(icon('pin', 12))}${item.location}</span>` : ''}
      ${flagPill(item.flag)}
    </span>${chevron}</div>`;
  return wrapDetail(item, inner, item.item_id);
}

function trayCard(entry, planNow, highlighted) {
  const { item, reason } = entry;
  const atRisk = reason.kind === 'atRisk';
  const due = smartTime(item.due_at, planNow);
  const money = item.money_at_risk > 0 ? `${dollars(item.money_at_risk)} at risk` : null;
  let body = '';
  if (atRisk && reason.needed > 0) {
    const scale = Math.max(reason.needed, reason.available, 1);
    const bar = (label, minutes, tint) => html`<div class="cap-row"><span class="cap-label">${label}</span><span class="cap-track"><span class="cap-fill ${tint}" style="width:max(8px, ${(Math.max(0, minutes) / scale) * 100}%)"></span></span></div>`;
    body = html`<div class="cap-bars">${bar(`needs ${reason.needed} min`, reason.needed, 'warning')}${bar(`you have ${reason.available} min`, reason.available, 'accent')}</div>`;
  } else if (!atRisk) {
    body = html`<span class="tl-time">${reason.minutes ? `Needs a gap · ~${reason.minutes} min` : 'Needs a gap'}</span>`;
  }
  const inner = html`<div class="tray-card ${atRisk ? 'at-risk' : 'gap'} ${highlighted ? 'highlight' : ''}">
    <span class="tray-head">${raw(icon(atRisk ? 'warning' : 'calendar', 12))}<span>${atRisk ? "DOESN'T FIT" : 'NEEDS A GAP'}</span><span class="spacer"></span>${money ? html`<span class="tray-money">${money}</span>` : ''}${opensDetail(item) ? raw(icon('chevronRight', 14, 'chevron')) : ''}</span>
    <span class="tl-title">${item.title}</span>
    ${due ? html`<span class="tl-time">Due ${due}</span>` : ''}
    ${body}</div>`;
  return wrapDetail(item, inner, item.item_id);
}

export function renderTimeline(plan, { highlighted, preset, presets, busy }) {
  const layout = layoutTimeline(plan);
  const rows = layout.rows.map((row) => {
    if (row.type === 'tick') return html`<span class="tl-tick" style="top:${row.y}px">${row.label}</span>`;
    if (row.type === 'gap') return html`<div class="tl-row tl-gap" style="top:${row.y}px;height:${row.height}px">${raw(icon('ellipsisV', 14))}<span>${row.label}</span></div>`;
    return html`<div class="tl-row" style="top:${row.y}px">${entryCard(row, highlighted.has(row.id))}</div>`;
  });
  return html`<section class="timeline" aria-label="Your day">
    <div class="tl-header">
      <span class="eyebrow">Your day</span>
      <div class="segmented" role="radiogroup" aria-label="Free time before class">
        ${presets.map((p) => html`<button type="button" role="radio" aria-checked="${p.id === preset}" class="${p.id === preset ? 'on' : ''}" data-action="preset" data-preset="${p.id}" ${busy ? raw('disabled') : ''}>${p.label}</button>`)}
      </div>
    </div>
    <div class="tl-rail-wrap">
      <div class="tl-now" aria-label="Now, ${layout.nowText}"><span class="tl-now-label">NOW</span><span class="tl-dot"></span><span class="tl-now-time">${layout.nowText}</span><span class="tl-now-line"></span></div>
      ${layout.tray.length ? html`<div class="tl-tray">${layout.tray.map((t) => trayCard(t, plan.reasoning.now, highlighted.has(t.item.item_id)))}</div>` : ''}
      ${layout.rows.length ? html`<div class="tl-canvas" data-timeline-canvas>${rows}</div>` : layout.tray.length ? '' : html`<p class="tl-empty">Nothing else is booked today.</p>`}
    </div>
  </section>`;
}

/**
 * After the timeline is in the DOM: cards taller than their design height (long titles) push every
 * later row down, exactly like TimelineCanvasLayout, so text never overlaps.
 */
export function settleTimeline(root) {
  const canvas = root.querySelector('[data-timeline-canvas]');
  if (!canvas) return;
  const rows = [...canvas.children];
  let shift = 0;
  let pushes = [];
  let bottom = 0;
  rows.forEach((row) => {
    const designTop = parseFloat(row.style.top);
    shift = pushes.reduce((total, p) => (designTop >= p.designBottom - 0.5 ? total + p.extra : total), 0);
    const top = designTop + shift;
    if (row.classList.contains('tl-tick')) {
      row.style.top = `${Math.max(0, top)}px`;
      return;
    }
    row.style.top = `${top}px`;
    const card = row.firstElementChild;
    const designHeight = card ? parseFloat(card.firstElementChild?.style.minHeight || row.style.height || 0) : 0;
    const actual = row.offsetHeight;
    if (designHeight && actual > designHeight + 0.5) pushes = [...pushes, { designBottom: designTop + designHeight, extra: actual - designHeight }];
    bottom = Math.max(bottom, top + actual);
  });
  canvas.style.height = `${bottom}px`;
}
