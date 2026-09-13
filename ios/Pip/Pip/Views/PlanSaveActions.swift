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
        case .denied: return "Notifications are off. Enable them in Settings, or turn off Notify me."
        case .tooMany: return "Too many alerts scheduled. Complete or delete a reminder first."
        case .pastDate: return "Pick a future time for the alert."
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
            SectionHeading(title: "Save your plan",
                           subtitle: plan.reasoning.answer == nil ? nil : "Add the event you discussed.")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { saveButtons(singleLine: true) }
                VStack(spacing: 10) { saveButtons(singleLine: false) }
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .tint(UniMateDesign.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
        .sheet(isPresented: $showCalendar) { CalendarDraftView(plan: plan) }
        .sheet(isPresented: $showReminders) { UniMateRemindersView(plan: plan) }
    }

    /// `singleLine` keeps labels on one line in the side-by-side layout so ViewThatFits falls back to stacking.
    @ViewBuilder
    private func saveButtons(singleLine: Bool) -> some View {
        Button { showCalendar = true } label: {
            Label("Add to Calendar", systemImage: "calendar.badge.plus")
                .font(.subheadline.weight(.semibold))
                .lineLimit(singleLine ? 1 : nil)
                .fixedSize(horizontal: singleLine, vertical: false)
                .frame(maxWidth: .infinity)
        }
        Button { showReminders = true } label: {
            Label("Reminders", systemImage: "bell.badge")
                .font(.subheadline.weight(.semibold))
                .lineLimit(singleLine ? 1 : nil)
                .fixedSize(horizontal: singleLine, vertical: false)
                .frame(maxWidth: .infinity)
        }
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
                    Section("UniMate’s advice") {
                        Text(answer)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Section {
                    Menu {
                        ForEach(plannedItems(plan)) { item in
                            Button(item.title) {
                                title = item.title
                                start = plannedDate(item.startsAt) ?? Date().addingTimeInterval(3600)
                                end = plannedDate(item.endsAt) ?? start.addingTimeInterval(Double(max(item.estMinutes ?? 60, 1)) * 60)
                                location = item.location ?? ""
                            }
                        }
                    } label: {
                        Label("Use a planned activity", systemImage: "list.bullet")
                    }
                    TextField("Event name", text: $title)
                    DatePicker("Starts", selection: $start)
                    DatePicker("Ends", selection: $end, in: start...)
                    TextField("Location", text: $location)
                } header: {
                    Text("Event")
                } footer: {
                    Text("Check times and travel before saving.")
                }
                Section {
                    Button { showEditor = true } label: {
                        Label("Review in Apple Calendar", systemImage: "calendar")
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || end <= start)
                    Button {
                        guard let url = GoogleCalendarLink.make(title: title, start: start, end: end, location: location) else { return }
                        openURL(url) { accepted in
                            googleOpened = accepted
                            googleFailed = !accepted
                        }
                    } label: {
                        Label("Review in Google Calendar", systemImage: "arrow.up.right.square")
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || end <= start)
                    if googleOpened {
                        Text("Tap Save in Google Calendar to finish. UniMate can’t confirm it saved.")
                            .font(.footnote).foregroundStyle(UniMateDesign.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if googleFailed {
                        Text("Couldn’t open Google Calendar. Check browser settings.")
                            .font(.footnote).foregroundStyle(UniMateDesign.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } footer: {
                    Text("Google gets the name, times and location. UniMate never reads calendars or changes your plan from them.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(UniMateDesign.background)
            .tint(UniMateDesign.accent)
            .navigationTitle("Add event")
            .navigationBarTitleDisplayMode(.inline)
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
                Section {
                    if plan != nil {
                        Menu {
                            ForEach(plannedItems(plan)) { item in
                                Button(item.title) {
                                    title = item.title
                                    date = plannedDate(item.startsAt ?? item.dueAt) ?? Date().addingTimeInterval(3600)
                                }
                            }
                        } label: {
                            Label("Use a task from your plan", systemImage: "list.bullet")
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
                } header: {
                    Text("New reminder")
                } footer: {
                    Text("Saved on this phone. Check dates copied from your plan.")
                }
                .disabled(saving)
                Section {
                    if store.items.isEmpty { Text("No reminders yet").foregroundStyle(UniMateDesign.secondary) }
                    ForEach(store.items.sorted { $0.date < $1.date }) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Label(item.title, systemImage: item.completed ? "checkmark.circle.fill" : (item.notify ? "bell" : "circle"))
                                .strikethrough(item.completed)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(item.date.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption).foregroundStyle(UniMateDesign.secondary)
                        }
                        .foregroundStyle(item.completed ? UniMateDesign.secondary : UniMateDesign.ink)
                        .swipeActions {
                            Button("Delete", role: .destructive) { store.remove(item) }
                            if !item.completed { Button("Done") { store.complete(item) }.tint(UniMateDesign.positive) }
                        }
                    }
                } header: {
                    Text("Your reminders")
                } footer: {
                    if !store.items.isEmpty {
                        Text("Swipe to complete or delete")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(UniMateDesign.background)
            .tint(UniMateDesign.accent)
            .navigationTitle("Reminders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .alert("Couldn’t save reminder", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
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
