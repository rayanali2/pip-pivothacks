// Sheets: Add to Calendar and Reminders (PlanSaveActions.swift) and Add block (ScheduleView.swift).
// Reminders live in chrome.storage and fire as Chrome notifications through background.js alarms.

import { html, raw } from '../dom.js';
import { allItems, hhmm, todayIsoDayOfWeek, weekdayName } from '../format.js';
import { i } from '../components.js';

// MARK: Reminders store

export async function loadReminders() {
  const { reminders } = await chrome.storage.local.get('reminders');
  return Array.isArray(reminders) ? reminders : [];
}

async function saveReminders(list) {
  await chrome.storage.local.set({ reminders: list });
}

export async function addReminder({ title, when, notify }) {
  const list = await loadReminders();
  if (notify && when <= Date.now()) throw new Error('Pick a future time for the alert.');
  if (notify && list.filter((r) => r.notify && !r.completed).length >= 60) throw new Error('Too many alerts scheduled. Complete or delete a reminder first.');
  const reminder = { id: crypto.randomUUID(), title, date: when, notify, completed: false };
  list.push(reminder);
  await saveReminders(list);
  if (notify) await chrome.alarms.create(`reminder:${reminder.id}`, { when });
  return list;
}

export async function completeReminder(id) {
  const list = await loadReminders();
  const item = list.find((r) => r.id === id);
  if (item) { item.completed = true; item.notify = false; }
  await chrome.alarms.clear(`reminder:${id}`);
  await saveReminders(list);
  return list;
}

export async function deleteReminder(id) {
  const list = (await loadReminders()).filter((r) => r.id !== id);
  await chrome.alarms.clear(`reminder:${id}`);
  await saveReminders(list);
  return list;
}

// MARK: Helpers

const pad = (n) => String(n).padStart(2, '0');

/** Value for <input type="datetime-local">. */
export function localInputValue(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function plannedOptions(plan) {
  const seen = new Set();
  return allItems(plan).filter((item) => !seen.has(item.item_id) && seen.add(item.item_id));
}

function sheetFrame(title, body, { confirm = null, confirmAction = null, confirmDisabled = false, cancel = 'Cancel' } = {}) {
  return html`<div class="sheet-backdrop" data-action="sheet-close-backdrop" data-anim="sheet:${title}">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
      <header class="sheet-head">
        <button type="button" class="link-button" data-action="sheet-close">${cancel}</button>
        <h2 class="nav-title">${title}</h2>
        ${confirm ? html`<button type="button" class="link-button strong" data-action="${confirmAction}" ${confirmDisabled ? raw('disabled') : ''}>${confirm}</button>` : raw('<span class="toolbar-spacer"></span>')}
      </header>
      <div class="sheet-body">${body}</div>
    </div>
  </div>`;
}

// MARK: Calendar

export function renderCalendarSheet(plan) {
  const start = Date.now() + 3600000;
  const options = plannedOptions(plan);
  return sheetFrame('Add event', html`
    ${plan?.reasoning.answer ? html`<section class="form-section"><h3 class="section-title">UniMate’s advice</h3><div class="form-card"><p>${plan.reasoning.answer}</p></div></section>` : ''}
    <section class="form-section">
      <h3 class="section-title">Event</h3>
      <div class="form-card">
        ${options.length ? html`<label class="form-row">${i('list', 15, 'accent-text')}<select id="cal-planned" data-action-change="cal-planned"><option value="">Use a planned activity</option>${options.map((item) => html`<option value="${item.item_id}">${item.title}</option>`)}</select></label>` : ''}
        <label class="form-row"><span>Event name</span><input id="cal-title" type="text" maxlength="200"></label>
        <label class="form-row"><span>Starts</span><input id="cal-start" type="datetime-local" value="${localInputValue(start)}"></label>
        <label class="form-row"><span>Ends</span><input id="cal-end" type="datetime-local" value="${localInputValue(start + 3600000)}"></label>
        <label class="form-row"><span>Location</span><input id="cal-location" type="text" maxlength="200"></label>
      </div>
      <p class="footnote">Check times and travel before saving.</p>
    </section>
    <section class="form-section">
      <div class="form-card">
        <button type="button" class="form-button" data-action="cal-google">${i('external', 15)}Review in Google Calendar</button>
        <button type="button" class="form-button" data-action="cal-ics">${i('download', 15)}Download for Apple or Outlook (.ics)</button>
      </div>
      <p class="footnote" id="cal-status">Google gets the name, times and location. UniMate never reads calendars or changes your plan from them.</p>
    </section>
  `, { cancel: 'Cancel' });
}

export function calendarDraft(root) {
  const title = root.querySelector('#cal-title').value.trim();
  const start = new Date(root.querySelector('#cal-start').value);
  const end = new Date(root.querySelector('#cal-end').value);
  const location = root.querySelector('#cal-location').value.trim();
  if (!title) throw new Error('Add an event name first.');
  if (!(end > start)) throw new Error('End must be after start.');
  return { title, start, end, location };
}

const utcStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Google Calendar's review-and-save screen (GoogleCalendarLink.swift). */
export function googleCalendarUrl({ title, start, end, location }) {
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', title);
  url.searchParams.set('dates', `${utcStamp(start)}/${utcStamp(end)}`);
  url.searchParams.set('location', location);
  url.searchParams.set('details', 'Added from UniMate.');
  return url.toString().replace(/\+/g, '%20');
}

export function icsFile({ title, start, end, location }) {
  const escape = (v) => v.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniMate//Chrome//EN', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@pip`, `DTSTAMP:${utcStamp(new Date())}`, `DTSTART:${utcStamp(start)}`, `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escape(title)}`, location ? `LOCATION:${escape(location)}` : null, 'DESCRIPTION:Added from UniMate.',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

// MARK: Reminders

export function renderRemindersSheet(plan, reminders, error) {
  const options = plan ? plannedOptions(plan) : [];
  const sorted = [...reminders].sort((a, b) => a.date - b.date);
  return sheetFrame('Reminders', html`
    <section class="form-section">
      <h3 class="section-title">New reminder</h3>
      <div class="form-card">
        ${options.length ? html`<label class="form-row">${i('list', 15, 'accent-text')}<select id="rem-planned" data-action-change="rem-planned"><option value="">Use a task from your plan</option>${options.map((item) => html`<option value="${item.item_id}">${item.title}</option>`)}</select></label>` : ''}
        <label class="form-row"><input id="rem-title" type="text" maxlength="200" placeholder="What do you want to remember?" aria-label="Reminder"></label>
        <label class="form-row"><span>When</span><input id="rem-when" type="datetime-local" value="${localInputValue(Date.now() + 3600000)}"></label>
        <label class="form-row toggle-row"><span>Notify me</span><input id="rem-notify" type="checkbox" class="switch" checked></label>
        <button type="button" class="form-button" data-action="rem-add">${i('plusCircle', 15)}Add reminder</button>
      </div>
      ${error ? html`<p class="footnote danger-text" role="alert">${error}</p>` : html`<p class="footnote">Saved in this browser. Check dates copied from your plan.</p>`}
    </section>
    <section class="form-section">
      <h3 class="section-title">Your reminders</h3>
      <div class="form-card">
        ${sorted.length ? sorted.map((r) => html`<div class="reminder ${r.completed ? 'completed' : ''}">
          ${i(r.completed ? 'checkCircle' : r.notify ? 'bell' : 'circleDotted', 16)}
          <span class="grow"><span class="reminder-title">${r.title}</span><small class="secondary-text">${new Date(r.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small></span>
          ${r.completed ? '' : html`<button type="button" class="mini-button positive" data-action="rem-done" data-id="${r.id}">Done</button>`}
          <button type="button" class="mini-button danger" data-action="rem-delete" data-id="${r.id}" aria-label="Delete ${r.title}">${i('trash', 14)}</button>
        </div>`) : html`<p class="secondary-text form-row">No reminders yet</p>`}
      </div>
    </section>
  `, { cancel: 'Done' });
}

// MARK: Add block

export function renderAddBlockSheet() {
  return sheetFrame('Add block', html`
    <section class="form-section">
      <div class="form-card">
        <label class="form-row"><span>Day</span><select id="block-day">${[1, 2, 3, 4, 5, 6, 7].map((d) => html`<option value="${d}" ${d === todayIsoDayOfWeek() ? raw('selected') : ''}>${weekdayName(d)}</option>`)}</select></label>
        <label class="form-row"><input id="block-title" type="text" maxlength="200" placeholder="Title, e.g. CHEM 110 Lab" aria-label="Title"></label>
        <label class="form-row"><span>Starts</span><input id="block-start" type="time" value="09:00"></label>
        <label class="form-row"><span>Ends</span><input id="block-end" type="time" value="10:00"></label>
        <label class="form-row"><input id="block-location" type="text" maxlength="200" placeholder="Location (optional)" aria-label="Location"></label>
      </div>
      <p class="footnote danger-text" id="block-error" hidden>${i('warning', 13)}End must be after start.</p>
    </section>
  `, { confirm: 'Add', confirmAction: 'block-add' });
}

export function readBlock(root) {
  const title = root.querySelector('#block-title').value.trim();
  const starts_at = root.querySelector('#block-start').value;
  const ends_at = root.querySelector('#block-end').value;
  const location = root.querySelector('#block-location').value.trim();
  const valid = title && starts_at && ends_at && ends_at > starts_at;
  root.querySelector('#block-error').hidden = !(starts_at && ends_at) || ends_at > starts_at;
  if (!valid) return null;
  return { day_of_week: Number(root.querySelector('#block-day').value), title, starts_at, ends_at, location: location || null };
}

export { hhmm };
