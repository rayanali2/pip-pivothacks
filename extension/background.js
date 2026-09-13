// Opens the side panel from the toolbar button, and stands in for the iPhone's Live Activity and
// local notifications: a minutes-left badge while focusing, and Chrome notifications for
// "time is up" and reminders.

const FOCUS_END = 'pip-focus-end';
const FOCUS_TICK = 'pip-focus-tick';
const ICON = 'icons/icon128.png';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.action.setBadgeBackgroundColor({ color: '#5763B3' }).catch(() => {});

async function updateBadge() {
  const { focusSession } = await chrome.storage.local.get('focusSession');
  if (!focusSession) { await chrome.action.setBadgeText({ text: '' }); return; }
  const minutes = Math.ceil((focusSession.endsAt - Date.now()) / 60000);
  await chrome.action.setBadgeText({ text: minutes > 0 ? `${minutes}m` : 'Up' });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'focus:start') {
    chrome.alarms.create(FOCUS_END, { when: Math.max(Date.now() + 1000, message.endsAt) });
    chrome.alarms.create(FOCUS_TICK, { periodInMinutes: 1 });
    // Storage may not have landed yet when the message arrives.
    setTimeout(updateBadge, 200);
  } else if (message?.type === 'focus:end') {
    chrome.alarms.clear(FOCUS_END);
    chrome.alarms.clear(FOCUS_TICK);
    chrome.action.setBadgeText({ text: '' });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === FOCUS_TICK) { await updateBadge(); return; }

  if (alarm.name === FOCUS_END) {
    const { focusSession } = await chrome.storage.local.get('focusSession');
    if (!focusSession) return;
    // An extension moved the end; the new alarm fires later.
    if (focusSession.endsAt - Date.now() > 5000) return;
    await updateBadge();
    chrome.notifications.create(`focus-${focusSession.id}`, {
      type: 'basic', iconUrl: ICON, title: 'Time is up',
      message: `${focusSession.title}: finished? Open UniMate for your next step.`, priority: 2,
    });
    return;
  }

  if (alarm.name.startsWith('reminder:')) {
    const id = alarm.name.slice('reminder:'.length);
    const { reminders } = await chrome.storage.local.get('reminders');
    const reminder = (reminders || []).find((r) => r.id === id);
    if (!reminder || reminder.completed || !reminder.notify) return;
    chrome.notifications.create(alarm.name, {
      type: 'basic', iconUrl: ICON, title: reminder.title, message: 'Your UniMate reminder is due.', priority: 1,
    });
  }
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
