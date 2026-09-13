// Port of ios/Pip/Pip/Views/Focus/FocusSessionView.swift. The Live Activity's job is done by a
// Chrome notification and the toolbar badge (background.js).

import { config } from '../api.js';
import { html, raw } from '../dom.js';
import { dollars } from '../format.js';
import { i } from '../components.js';
import { penguinSlot } from './home.js';

const RADIUS = 110;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const focusTimeUp = (session) => Date.now() >= session.endsAt;

export function renderFocus(session, s) {
  const timeUp = focusTimeUp(session);
  const planText = session.extendedMinutes > 0 ? `${session.plannedMinutes} min planned · +${session.extendedMinutes} min` : `${session.plannedMinutes} min planned`;
  const money = session.moneyAtRisk > 0 ? session.moneyAtRisk : null;
  const extend = html`<button type="button" class="btn-secondary grow" data-action="focus-extend" aria-label="Add 10 minutes">${i('timer', 15)}+10 min</button>`;

  return html`<div class="focus-overlay" data-anim="focus:${session.id}" role="dialog" aria-modal="true" aria-label="Focus">
    <header class="row between focus-top">
      <span class="eyebrow wide">Focus</span>
      <button type="button" class="icon-button" data-action="focus-close" aria-label="Close focus">${i('x', 17)}</button>
    </header>
    <div class="focus-scroll">
      ${penguinSlot('focus', 120, s.pipState === 'speaking' ? 'speaking' : 'idle', timeUp)}
      <div class="center">
        <h2 class="heading">${session.title}</h2>
        <p class="secondary-text">${session.action}</p>
      </div>
      <div class="focus-ring" data-focus-ring data-start="${session.startedAt}" data-end="${session.endsAt}">
        <svg viewBox="0 0 248 248" aria-hidden="true">
          <circle cx="124" cy="124" r="${RADIUS}" class="ring-track"/>
          <circle cx="124" cy="124" r="${RADIUS}" class="ring-fill" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${timeUp ? 0 : CIRCUMFERENCE}"/>
        </svg>
        <span class="ring-center"><span class="ring-clock mono" data-focus-clock>${timeUp ? '00:00' : ''}</span><small class="mono">${planText}</small></span>
      </div>
      ${session.nextLabel || money ? html`<section class="card">
        ${session.nextLabel ? html`<div class="context-row">${i('arrowTurn', 17, 'accent-text')}<span><strong>Then: ${session.nextLabel}</strong>${session.nextLocation ? html`<small class="secondary-text">${session.nextLocation}</small>` : ''}</span></div>` : ''}
        ${money ? html`<div class="context-row">${i('dollar', 17, 'warning-text')}<span><strong>${dollars(money)} on the line</strong></span></div>` : ''}
      </section>` : ''}
      <p class="secondary-text small-label center-self">${i('bell', 13)}Chrome will notify you when time is up</p>
      ${timeUp ? html`<section class="card emphasized">
        <strong class="accent-text small-label">${i('bell', 15)}Time is up</strong>
        <p class="secondary-text">Finished? UniMate will pick your next step.</p>
        <button type="button" class="btn-primary" data-action="focus-done">${i('check', 16)}Done: what next?</button>
        <div class="button-row">${extend}<button type="button" class="btn-secondary grow" data-action="focus-stuck" ${s.pipState === 'thinking' ? raw('disabled') : ''}>${i('question', 15)}I’m stuck</button></div>
      </section>` : html`<div class="button-row">${extend}<button type="button" class="btn-secondary grow" data-action="focus-done">${i('check', 15)}Done early</button></div>
        ${config.demoMode ? html`<button type="button" class="link-button center-self" data-action="focus-skip">Skip to end (demo)</button>` : ''}`}
    </div>
  </div>`;
}

/** Called every second while the overlay is open. */
export function tickFocus(root) {
  const ring = root.querySelector('[data-focus-ring]');
  if (!ring) return;
  const start = Number(ring.dataset.start);
  const end = Number(ring.dataset.end);
  const now = Date.now();
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));
  const fraction = end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
  ring.querySelector('.ring-fill').setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - fraction)));
  const clock = ring.querySelector('[data-focus-clock]');
  clock.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  ring.setAttribute('aria-label', `${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds left`);
}
