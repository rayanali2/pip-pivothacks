// Port of ios/Pip/Pip/Views/HomeView.swift: talk or type, watch the pipeline, get one do-now.

import { config } from '../api.js';
import { html, raw } from '../dom.js';
import { opensDetail, time, timeLabel } from '../format.js';
import { disclosure, flagPill, i, overrunPreview, pill, pipelineReveal, sourceLabelView, stakesStrip, statusView } from '../components.js';

export const DEMO_SENTENCE = 'I have a 2 PM lab. I need to return headphones by 5 PM or lose the refund. My assignment is due tomorrow. I need groceries, and I have $35 until Friday. What should I do?';

export const hasResult = (s) => s.hasCapture && s.currentPlan?.do_now && !s.needsText && s.pipState !== 'listening' && !s.isRevealingPipeline;

export function muteButton(s) {
  return html`<button type="button" class="icon-button" data-action="mute" aria-label="${s.muted ? 'Unmute Pip' : 'Mute Pip'}">${i(s.muted ? 'speakerOff' : 'speaker', 17)}</button>`;
}

export function penguinSlot(key, size, state, ready = false) {
  return html`<div class="penguin-slot" data-penguin="${key}" data-state="${state}" data-ready="${ready}" style="--size:${size}px"></div>`;
}

function contextFacts(s) {
  const timetable = s.todayTimetable;
  if (!timetable && !s.currentPlan) return '';
  const window = s.currentPlan?.reasoning.free_window ?? timetable?.next_free_window;
  const now = s.currentPlan?.reasoning.now ?? timetable?.now;
  const minutes = s.currentPlan?.reasoning.context.available_minutes ?? window?.minutes;
  const at = time(window?.next_block_starts_at);
  return html`<div class="context-facts">
    <span class="fact"><span class="eyebrow">${i('clock', 11)}Now</span><strong>${time(now) || '—'}</strong></span>
    <span class="fact-divider"></span>
    <span class="fact grow"><span class="eyebrow">${i('graduation', 11)}Next class</span><strong>${window?.next_block_title || 'No upcoming class'}</strong>${at ? html`<small>${at}</small>` : ''}</span>
    ${minutes != null ? html`<span class="fact-divider"></span><span class="fact"><span class="eyebrow">${i('hourglass', 11)}Free</span><strong class="accent-text">${minutes} min</strong></span>` : ''}
  </div>`;
}

export function doNowCard(item, s, ui) {
  const planNow = s.currentPlan.reasoning.now;
  const started = s.startNowConfirmation === item.item_id;
  const highlighted = s.highlighted.has(item.item_id);
  return html`<article class="card emphasized do-now ${highlighted ? 'highlight' : ''}">
    <div class="row between"><span class="eyebrow accent">${i('sparkle', 11)}Do this now</span>${flagPill(item.flag)}</div>
    <h2 class="title">${item.title}</h2>
    ${stakesStrip(item, planNow, { expandedRule: ui.expandedRules.get(`home:${item.item_id}`), key: `home:${item.item_id}` })}
    <p class="body-text">${item.action}</p>
    ${item.est_minutes ? html`<div class="flow">${pill(`${item.est_minutes} min`, { symbol: 'timer' })}</div>` : ''}
    <button type="button" class="btn-primary" data-action="start-now" data-item="${item.item_id}" ${started ? raw('disabled') : ''}>${i(started ? 'check' : 'play', 16)}${started ? 'Started' : 'Start now'}</button>
    ${started ? html`<p class="positive-text small-label">${i('checkCircle', 14)}Saved to History</p>` : ''}
    ${overrunPreview(item, s)}
    <p class="secondary-text">${item.why}</p>
    ${opensDetail(item) ? html`<button type="button" class="link-button center" data-action="open-detail" data-item="${item.item_id}">Why this is first ${i('chevronRight', 12)}</button>` : ''}
  </article>`;
}

function upNext(plan) {
  const seen = new Set([plan.do_now?.item_id]);
  const items = [plan.next, ...plan.today].filter((x) => x && !seen.has(x.item_id) && seen.add(x.item_id)).slice(0, 3);
  return html`<div class="up-next">
    <div class="row between">${items.length ? html`<span class="eyebrow">Up next</span>` : raw('<span></span>')}
      <button type="button" class="link-button" data-action="tab" data-tab="today" aria-label="See the rest of today">See all ${i('chevronRight', 12)}</button></div>
    ${items.length ? html`<div class="list-card">${items.map((item) => html`<div class="up-next-row">
      <span class="accent-text">${i(item.kind === 'fixed_block' ? 'lock' : 'circleDotted', 13)}</span>
      <span class="grow truncate">${item.title}</span>
      ${timeLabel(item, plan.reasoning.now) ? html`<span class="mono secondary-text">${timeLabel(item, plan.reasoning.now)}</span>` : ''}
    </div>`)}</div>` : ''}
  </div>`;
}

function transcriptCard(s) {
  if (s.needsText) {
    return html`<section class="card">
      ${statusView('micOff', 'Let’s try typing', 'Pip couldn’t hear that.')}
      <button type="button" class="btn-primary" data-action="focus-input">Type instead</button>
    </section>`;
  }
  const edited = s.hasCapture && s.draft.trim() && s.draft.trim() !== s.transcript.trim();
  return html`<section class="card">${disclosure('home:words', 'Your words', html`
    <textarea id="draft-input" class="field" rows="3" aria-label="What you said" data-bind="draft">${s.draft}</textarea>
    ${edited ? html`<button type="button" class="btn-primary" data-action="update-transcript" ${s.pipState === 'thinking' ? raw('disabled') : ''}>Update plan</button>` : ''}
  `, { symbol: 'bubble', cls: 'flush' })}</section>`;
}

export function recordingStatus(s) {
  return html`<span class="recording-status" role="status"><span class="rec-dot"></span><strong>Listening</strong><span class="mono" data-elapsed="${s.recordingStartedAt || Date.now()}">0:00</span><span>· release to send</span></span>`;
}

export function renderHome(s, ui) {
  const result = hasResult(s);
  const thinking = s.pipState === 'thinking' || s.isRevealingPipeline;
  const busy = s.pipState === 'thinking';
  const listeningHere = s.pipState === 'listening' && !s.isFollowUpRecording;
  const typed = (ui.homeText || '').trim();

  return html`<div class="page home">
    <header class="row between"><h1 class="title">Hey, I’m Pip.</h1>${muteButton(s)}</header>
    ${contextFacts(s)}
    <div class="hero">
      ${penguinSlot('home', result || s.needsText ? 60 : 128, s.pipState, !!result)}
      ${!result && !s.needsText && s.pipState === 'idle' ? html`<h2 class="heading center">What’s on your mind?</h2><p class="secondary-text center">Say it all. I’ll pick one thing.</p>` : ''}
    </div>
    ${thinking ? html`
      ${s.isRevealingPipeline ? pipelineReveal(s.pipelineStages, s.revealedStageCount) : html`<section class="card">${statusView('', 'Finding your next step', 'Checking time, tasks and deadlines', { loading: true })}</section>`}
      ${s.submittedText ? html`<p class="quote">“${s.submittedText.length > 180 ? `${s.submittedText.slice(0, 180)}…` : s.submittedText}”</p>` : ''}
    ` : result ? html`${doNowCard(s.currentPlan.do_now, s, ui)}${upNext(s.currentPlan)}` : ''}
    ${s.hasCapture && s.pipState !== 'listening' ? transcriptCard(s) : ''}
    <div class="controls">
      ${listeningHere ? recordingStatus(s) : ''}
      <button type="button" class="mic ${listeningHere ? 'listening' : ''} ${result ? 'small' : ''}" data-mic="home" ${busy ? raw('disabled') : ''} aria-label="${listeningHere ? 'Stop recording and send' : 'Hold to talk'}">${i(listeningHere ? 'waveform' : 'mic', result ? 24 : 32)}</button>
      <span class="caption">${listeningHere ? 'Release or tap to send' : result ? 'Hold to tell Pip more' : 'Hold to talk'}</span>
      <form class="composer" data-form="home-send">
        <textarea id="home-input" class="field" rows="1" placeholder="Or type your day…" maxlength="5000" data-bind="homeText" aria-label="Type your day">${ui.homeText || ''}</textarea>
        <button type="submit" class="send" aria-label="Send your day" ${!typed || busy ? raw('disabled') : ''}>${i('arrowUp', 18)}</button>
      </form>
      <div class="row between wrap">
        <span class="row gap">
          <button type="button" class="chip-button" data-action="scan" ${busy ? raw('disabled') : ''}>${i('scan', 14)}Scan this tab</button>
          ${config.demoMode ? html`<button type="button" class="link-button" data-action="demo-sentence">${i('bubble', 13)}Use demo sentence</button>` : ''}
        </span>
        ${sourceLabelView(s.lastSource)}
      </div>
      ${s.isOffline ? statusView('wifiOff', 'Server unavailable', 'Reconnect to create or update your plan. Check the server address in Schedule.') : ''}
    </div>
  </div>`;
}
