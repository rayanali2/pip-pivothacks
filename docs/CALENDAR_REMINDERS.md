# Calendar and reminders: device verification

The Today screen now offers Save your plan after any voice/text plan or follow-up answer. Add to Calendar opens an editable draft (including the latest advice) and then Apple's event editor. A planned activity can prefill its title, dates and location; a new discussed event is entered by the user. The event is written only when the user saves in Apple's editor. On iOS 17+, this EventKitUI workflow needs no calendar-read permission.

The bell on Today opens Pip's local reminder list even before a plan exists. Reminders persist in UserDefaults on that installation; they do not sync to Snowflake or Apple Reminders. Each reminder has a chosen date and an optional local notification. Completing or deleting cancels its pending and delivered notification. Local notification permissions are requested only when saving an alert. Foreground alerts are enabled. No APNs server or background polling is needed.

Saving a calendar event does not add it to Pip's timetable. Device-calendar conflict checking and automatic extraction of a discussed event into a structured draft are not implemented. Pip displays its existing follow-up advice while the user reviews event details.

## Run on Mac / iPhone

1. Build the Pip scheme in Xcode 16 (iOS 17+). The synchronized source folder includes PlanSaveActions.swift automatically; XcodeGen also includes it through the Pip source directory.
2. Generate a plan, ask about an event, and check that Save your plan appears underneath the answer.
3. Add a new event; review its dates, cancel Apple's editor and verify nothing was saved. Repeat and save, then verify it in Apple Calendar. Select a planned activity and verify its times/location prefill. Check dark mode, Dynamic Type and a narrow iPhone display.
4. Open Today > bell. Save one reminder without Notify me, close/reopen and relaunch Pip: it should persist without a scheduled alert.
5. Save a reminder two minutes in the future with Notify me; grant permission. Verify one alert both with Pip foregrounded and backgrounded, subject to Focus/system settings.
6. Deny notification permission; the save must report the error and keep the form. Turn Notify me off to save a non-notifying reminder. Past notification times must be rejected.
7. Complete or delete a future reminder; verify the scheduled alert is removed. Verify the notification-cap error preserves existing reminders.

Windows validation: source integration and diff checks only. EventKit/UIKit compilation, permission dialogs and delivery require the device checks above.

## Google Calendar

The draft offers Review in Google Calendar as well as Apple Calendar. Google opens with only the reviewed name, start/end, location and a generic note; the conversation and Pip's advice are not included. The user signs in if needed, chooses the destination calendar and event notifications, and taps Save. Pip does not claim success from opening the URL and cannot detect cancellation or saving. Pip reminders remain local notifications, separate from Google Calendar event notifications.

Device checks: open the Google option with an event titled `Study + coffee & review #1`, accented characters and a location containing `&`; verify exact text, start/end and date. Test across midnight and DST, cancel without saving, save once and check Google Calendar, and test signed-out behavior. Verify browser-open failure feedback. iOS compilation and the Google handoff still require a Mac/iPhone test.
