import SwiftUI
import Combine
import EventKit
import EventKitUI
import UserNotifications

private struct UniMateReminder: Codable, Identifiable {
    let id: UUID
    var title: String
    var date: Date
    var notify: Bool
    var completed: Bool
}

@MainActor
private final class ReminderListStore: ObservableObject {
    @Published var items: [UniMateReminder] = []
    private let key = "pip.reminders.v1"
    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let saved = try? JSONDecoder().decode([UniMateReminder].self, from: data) { items = saved }
    }
    func save() {
        if let data = try? JSONEncoder().encode(items) { UserDefaults.standard.set(data, forKey: key) }
    }
    func remove(_ item: UniMateReminder) {
        cancel(item)
        items.removeAll { $0.id == item.id }
        save()
    }
    func complete(_ item: UniMateReminder) {
        cancel(item)
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index].completed = true
            items[index].notify = false
            save()
        }
    }
    private func cancel(_ item: UniMateReminder) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [item.id.uuidString])
        center.removeDeliveredNotifications(withIdentifiers: [item.id.uuidString])
    }
    func add(title: String, date: Date, notify: Bool) async throws {
        let item = UniMateReminder(id: UUID(), title: title, date: date, notify: notify, completed: false)
        if notify {
            guard date > Date() else { throw ReminderFailure.pastDate }
            let center = UNUserNotificationCenter.current()
            guard try await center.requestAuthorization(options: [.alert, .sound]) else {
                throw ReminderFailure.denied
            }
            let pending = await center.pendingNotificationRequests()
            guard pending.count < 60 else { throw ReminderFailure.tooMany }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = "Your UniMate reminder is due."
            content.sound = .default
            let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            try await center.add(UNNotificationRequest(identifier: item.id.uuidString, content: content, trigger: trigger))
        }
        items.append(item)
        save()
    }
}

private enum ReminderFailure: LocalizedError {
    case denied, pastDate, tooMany
    var errorDescription: String? {
        switch self {
        case .denied: return "Notifications are disabled. Enable them for UniMate in Settings, or turn off Notify me to save without an alert."
        case .tooMany: return "Your notification list is full. Complete or delete an existing reminder first."
        case .pastDate: return "Choose a future time for the notification."
        }
    }
}

/// User-reviewed exports. Saving a calendar event does not silently change the server plan.
struct PlanSaveActions: View {
    let plan: Plan
    @State private var showCalendar = false
    @State private var showReminders = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Save your plan").font(.headline)
            Text(plan.reasoning.answer == nil
                 ? "Add a planned activity to Calendar or make a reminder list."
                 : "Want to add the event you discussed to Calendar, or set a reminder?")
                .font(.subheadline).foregroundStyle(.secondary)
            HStack {
                Button("Add to Calendar", systemImage: "calendar.badge.plus") { showCalendar = true }
                Button("Reminders", systemImage: "bell.badge") { showReminders = true }
            }
            .buttonStyle(.bordered)
        }
        .sheet(isPresented: $showCalendar) { CalendarDraftView(plan: plan) }
        .sheet(isPresented: $showReminders) { UniMateRemindersView(plan: plan) }
    }
}

private func plannedItems(_ plan: Plan?) -> [PlanItem] {
    guard let plan else { return [] }
    var seen = Set<String>()
    return ([plan.doNow, plan.next].compactMap { $0 } + plan.today + plan.canWait)
        .filter { seen.insert($0.itemId).inserted }
}

private func plannedDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
}

private struct CalendarDraftView: View {
    let plan: Plan
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var start = Date().addingTimeInterval(3600)
    @State private var end = Date().addingTimeInterval(7200)
    @State private var location = ""
    @Environment(\.openURL) private var openURL
    @State private var googleOpened = false
    @State private var googleFailed = false
    @State private var showEditor = false
    @State private var saved = false

    var body: some View {
        NavigationStack {
            Form {
                if let answer = plan.reasoning.answer {
                    Section("UniMate's advice") { Text(answer) }
                }
                Section("Review the event") {
                    Menu("Use a planned activity") {
                        ForEach(plannedItems(plan)) { item in
                            Button(item.title) {
                                title = item.title
                                start = plannedDate(item.startsAt) ?? Date().addingTimeInterval(3600)
                                end = plannedDate(item.endsAt) ?? start.addingTimeInterval(Double(max(item.estMinutes ?? 60, 1)) * 60)
                                location = item.location ?? ""
                            }
                        }
                    }
                    TextField("Event name", text: $title)
                    DatePicker("Starts", selection: $start)
                    DatePicker("Ends", selection: $end, in: start...)
                    TextField("Location", text: $location)
                    Text("For a new event you discussed, enter its name and times. Check travel time and UniMate's advice before saving.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("Review in Apple Calendar") { showEditor = true }
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || end <= start)
                    Button("Review in Google Calendar") {
                        guard let url = GoogleCalendarLink.make(title: title, start: start, end: end, location: location) else { return }
                        openURL(url) { accepted in
                            googleOpened = accepted
                            googleFailed = !accepted
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || end <= start)
                    if googleOpened {
                        Text("Finish by tapping Save in Google Calendar. UniMate cannot confirm whether you saved the event.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if googleFailed {
                        Text("Could not open Google Calendar. Check your browser settings and try again.")
                            .font(.footnote).foregroundStyle(.red)
                    }
                    Text("Google Calendar receives the event name, times and location when you open it. Choose your Google account, calendar and notification settings there, then Save. UniMate does not read either calendar or update its plan from saved events.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Add event")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .sheet(isPresented: $showEditor) {
                CalendarEventEditor(title: title, start: start, end: end, location: location) { didSave in
                    showEditor = false
                    saved = didSave
                }
            }
            .alert("Event saved to Calendar", isPresented: $saved) { Button("Done") { dismiss() } }
        }
    }
}

private struct CalendarEventEditor: UIViewControllerRepresentable {
    let title: String
    let start: Date
    let end: Date
    let location: String
    let finished: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(finished: finished) }
    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let editor = EKEventEditViewController()
        editor.eventStore = context.coordinator.store
        let event = EKEvent(eventStore: context.coordinator.store)
        event.title = title
        event.startDate = start
        event.endDate = end
        event.location = location
        editor.event = event
        editor.editViewDelegate = context.coordinator
        return editor
    }
    func updateUIViewController(_ uiViewController: EKEventEditViewController, context: Context) {}
    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let store = EKEventStore()
        let finished: (Bool) -> Void
        init(finished: @escaping (Bool) -> Void) { self.finished = finished }
        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            finished(action == .saved)
        }
    }
}

struct UniMateRemindersView: View {
    var plan: Plan? = nil
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = ReminderListStore()
    @State private var title = ""
    @State private var date = Date().addingTimeInterval(3600)
    @State private var notify = true
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section("New reminder") {
                    if plan != nil {
                        Menu("Use a task from your plan") {
                            ForEach(plannedItems(plan)) { item in
                                Button(item.title) {
                                    title = item.title
                                    date = plannedDate(item.startsAt ?? item.dueAt) ?? Date().addingTimeInterval(3600)
                                }
                            }
                        }
                    }
                    TextField("What do you want to remember?", text: $title)
                    DatePicker("When", selection: $date)
                    Toggle("Notify me", isOn: $notify)
                    Button(saving ? "Saving…" : "Add reminder") {
                        saving = true
                        Task { @MainActor in
                            defer { saving = false }
                            do {
                                try await store.add(title: title.trimmingCharacters(in: .whitespacesAndNewlines), date: date, notify: notify)
                                title = ""
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (notify && date <= Date()))
                    Text("Reminders are saved on this phone. Alerts require notification permission and may be silenced by Focus. Review dates from a demo plan before saving.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .disabled(saving)
                Section("Your reminders") {
                    if store.items.isEmpty { Text("No reminders yet").foregroundStyle(.secondary) }
                    ForEach(store.items.sorted { $0.date < $1.date }) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Label(item.title, systemImage: item.completed ? "checkmark.circle.fill" : (item.notify ? "bell" : "circle"))
                                .strikethrough(item.completed)
                            Text(item.date.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button("Delete", role: .destructive) { store.remove(item) }
                            if !item.completed { Button("Done") { store.complete(item) }.tint(.green) }
                        }
                    }
                }
            }
            .navigationTitle("Reminders")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .alert("Couldn't save reminder", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK") { error = nil }
            } message: { Text(error ?? "") }
        }
    }
}

/// Keep a strong reference: UNUserNotificationCenter's delegate is weak.
final class UniMateNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = UniMateNotificationDelegate()
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
