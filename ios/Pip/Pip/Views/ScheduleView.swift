import SwiftUI

struct ScheduleView: View {
    @Environment(AppModel.self) private var model
    @State private var showingAddBlock = false

    var body: some View {
        NavigationStack {
            Form {
                todaySection
                weekSection
                ProfileSection()
                ServerSection()
            }
            .navigationTitle("Schedule")
            .scrollDismissesKeyboard(.interactively)
            .refreshable {
                await model.refreshSchedule()
                await model.refreshProfile()
            }
            .sheet(isPresented: $showingAddBlock) {
                AddBlockSheet { block in
                    addBlock(block)
                }
            }
        }
    }

    // MARK: Today

    private var todayBlocks: [TimetableBlock] {
        (model.todayTimetable?.blocks ?? []).sorted { $0.startsAt < $1.startsAt }
    }

    private var todaySection: some View {
        Section("Today") {
            if todayBlocks.isEmpty {
                Text("No fixed blocks today.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(todayBlocks) { block in
                    TimelineBlockRow(block: block)
                }
            }
        }
    }

    // MARK: Week

    private var weekSection: some View {
        Section {
            ForEach(Array(1...7), id: \.self) { day in
                dayRows(day)
            }
            Button {
                showingAddBlock = true
            } label: {
                Label("Add block", systemImage: "plus")
            }
        } header: {
            Text("Weekly timetable")
        } footer: {
            Text("Swipe left on a block to delete it.")
        }
    }

    @ViewBuilder
    private func dayRows(_ day: Int) -> some View {
        let dayBlocks = blocks(on: day)
        if !dayBlocks.isEmpty {
            Text(DateFormatting.weekdayName(day))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            ForEach(dayBlocks) { block in
                WeekBlockRow(block: block)
            }
            .onDelete { offsets in
                deleteBlocks(on: day, at: offsets)
            }
        }
    }

    private func blocks(on day: Int) -> [TimetableBlock] {
        model.weekTimetable
            .filter { $0.dayOfWeek == day }
            .sorted { $0.startsAt < $1.startsAt }
    }

    private func deleteBlocks(on day: Int, at offsets: IndexSet) {
        let dayBlocks = blocks(on: day)
        let removedIDs = Set(offsets.compactMap { index in
            index < dayBlocks.count ? dayBlocks[index].id : nil
        })
        let remaining = model.weekTimetable.filter { !removedIDs.contains($0.id) }
        Task {
            await model.saveTimetable(remaining)
        }
    }

    private func addBlock(_ block: TimetableBlock) {
        var blocks = model.weekTimetable
        if !blocks.contains(where: { $0.id == block.id }) {
            blocks.append(block)
        }
        Task {
            await model.saveTimetable(blocks)
        }
    }
}

// MARK: - Rows

private struct TimelineBlockRow: View {
    let block: TimetableBlock

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .trailing, spacing: 2) {
                Text(DateFormatting.timeOfDay(block.startsAt))
                    .font(.subheadline.monospacedDigit())
                Text(DateFormatting.timeOfDay(block.endsAt))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .frame(width: 76, alignment: .trailing)

            Capsule()
                .fill(Color.accentColor)
                .frame(width: 3, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(block.title)
                    .font(.body.weight(.medium))
                if let location = block.location, !location.isEmpty {
                    Text(location)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

private struct WeekBlockRow: View {
    let block: TimetableBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(block.title)
                .font(.body)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var detail: String {
        var parts = [DateFormatting.timeRange(block.startsAt, block.endsAt)]
        if let location = block.location, !location.isEmpty {
            parts.append(location)
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Add block

private struct AddBlockSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (TimetableBlock) -> Void

    @State private var day = DateFormatting.todayISODayOfWeek()
    @State private var title = ""
    @State private var start = AddBlockSheet.time(hour: 9)
    @State private var end = AddBlockSheet.time(hour: 10)
    @State private var location = ""

    private static func time(hour: Int) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) ?? Date()
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var startText: String {
        DateFormatting.hhmm(from: start)
    }

    private var endText: String {
        DateFormatting.hhmm(from: end)
    }

    private var timesValid: Bool {
        endText > startText
    }

    private var isValid: Bool {
        !trimmedTitle.isEmpty && timesValid
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Day", selection: $day) {
                    ForEach(Array(1...7), id: \.self) { value in
                        Text(DateFormatting.weekdayName(value)).tag(value)
                    }
                }
                TextField("Title, e.g. CHEM 110 Lab", text: $title)
                DatePicker("Starts", selection: $start, displayedComponents: .hourAndMinute)
                DatePicker("Ends", selection: $end, displayedComponents: .hourAndMinute)
                TextField("Location (optional)", text: $location)
                if !timesValid {
                    Text("The end time must be after the start time.")
                        .font(.footnote)
                        .foregroundStyle(Color.red)
                }
            }
            .navigationTitle("Add block")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        save()
                    }
                    .disabled(!isValid)
                }
            }
        }
    }

    private func save() {
        guard isValid else { return }
        let trimmedLocation = location.trimmingCharacters(in: .whitespacesAndNewlines)
        let block = TimetableBlock(
            studentId: Config.studentID,
            dayOfWeek: day,
            title: trimmedTitle,
            startsAt: startText,
            endsAt: endText,
            location: trimmedLocation.isEmpty ? nil : trimmedLocation
        )
        onSave(block)
        dismiss()
    }
}

// MARK: - Money & routine

private struct ProfileSection: View {
    @Environment(AppModel.self) private var model

    @State private var cashText = ""
    @State private var budgetUntil = Date()
    @State private var cooksOwnMeals = true
    @State private var chronotype: Chronotype = .neutral
    @State private var procrastinatesOn: TaskCategory? = nil
    @State private var isSaving = false
    @State private var savedMessage: String?

    var body: some View {
        Section {
            HStack {
                Text("Cash available")
                Spacer()
                Text("$")
                    .foregroundStyle(.secondary)
                TextField("0", text: $cashText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 110)
            }
            .onAppear {
                loadDraft()
            }
            .onChange(of: model.profile) { _, _ in
                loadDraft()
            }

            DatePicker("Budget until", selection: $budgetUntil, displayedComponents: .date)

            Toggle("Cooks own meals", isOn: $cooksOwnMeals)

            Picker("Chronotype", selection: $chronotype) {
                ForEach(Chronotype.known, id: \.self) { value in
                    Text(value.label).tag(value)
                }
            }

            Picker("Procrastinates on", selection: $procrastinatesOn) {
                Text("Nothing in particular").tag(TaskCategory?.none)
                ForEach(TaskCategory.known, id: \.self) { value in
                    Text(value.label).tag(TaskCategory?.some(value))
                }
            }

            Button {
                save()
            } label: {
                HStack {
                    Text("Save")
                    Spacer()
                    if isSaving {
                        ProgressView()
                    } else if let savedMessage {
                        Text(savedMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .disabled(isSaving)
        } header: {
            Text("Money & routine")
        }
    }

    private func loadDraft() {
        guard let profile = model.profile else { return }
        cashText = Self.plainAmount(profile.cashAvailable)
        budgetUntil = DateFormatting.parseIsoDate(profile.budgetUntil) ?? Date()
        cooksOwnMeals = profile.cooksOwnMeals
        chronotype = profile.chronotype == .unknown ? .neutral : profile.chronotype
        if let category = profile.procrastinatesOn, category != .unknown {
            procrastinatesOn = category
        } else {
            procrastinatesOn = nil
        }
    }

    private func save() {
        let cleaned = cashText
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: ".")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        var request = PutProfileRequest()
        request.chronotype = chronotype
        request.cooksOwnMeals = cooksOwnMeals
        request.cashAvailable = Double(cleaned)
        request.budgetUntil = DateFormatting.isoDate(from: budgetUntil)
        request.procrastinatesOn = procrastinatesOn

        isSaving = true
        savedMessage = nil
        Task {
            let ok = await model.saveProfile(request)
            isSaving = false
            savedMessage = ok ? "Saved" : nil
        }
    }

    private static func plainAmount(_ amount: Double) -> String {
        guard amount.isFinite, abs(amount) < 1_000_000_000 else { return "" }
        if amount.rounded() == amount {
            return String(Int(amount))
        }
        return String(format: "%.2f", amount)
    }
}

// MARK: - Server

private struct ServerSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Section {
            TextField("http://192.168.1.20:3000", text: $model.serverURLString)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            Button {
                Task {
                    await model.testConnection()
                }
            } label: {
                HStack {
                    Text("Test connection")
                    Spacer()
                    if model.isTestingConnection {
                        ProgressView()
                    }
                }
            }
            .disabled(model.isTestingConnection)

            if let status = model.connectionStatus {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let health = model.health {
                HealthSummary(health: health, isOffline: model.isOffline)
            }

            Button("Reset demo data", role: .destructive) {
                Task {
                    await model.resetDemo()
                }
            }
        } header: {
            Text("Server")
        } footer: {
            Text("On a phone, use your laptop's LAN IP, e.g. http://192.168.1.20:3000. If the server can't be reached, Pip uses local fallback data.")
        }
    }
}

private struct HealthSummary: View {
    let health: HealthResponse
    let isOffline: Bool

    private var modeText: String {
        isOffline ? "Local fallback (offline)" : health.mode.capitalized
    }

    private var snowflakeText: String {
        if isOffline { return "Not reachable" }
        if health.snowflake.connected { return "Connected" }
        if health.snowflake.configured { return "Configured, not connected" }
        return "Not configured"
    }

    private var cortexText: String {
        let parts = [health.cortex.complete, health.cortex.completeModel].compactMap { $0 }
        return parts.isEmpty ? "Not verified" : parts.joined(separator: " · ")
    }

    var body: some View {
        Group {
            LabeledContent("Mode", value: modeText)
            LabeledContent("Snowflake", value: snowflakeText)
            LabeledContent("Cortex", value: cortexText)
            if let transcribe = health.cortex.transcribe {
                LabeledContent("Transcribe", value: transcribe)
            }
            if let error = health.snowflake.error, !error.isEmpty, !isOffline {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Color.red)
            }
        }
        .font(.subheadline)
    }
}

#Preview("Schedule") {
    ScheduleView()
        .environment(AppModel.preview())
}
