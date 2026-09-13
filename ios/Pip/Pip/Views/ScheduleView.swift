import SwiftUI

struct ScheduleView: View {
    @Environment(AppModel.self) private var model
    @State private var showingAddBlock = false

    var body: some View {
        NavigationStack {
            Form {
                todaySection
                unscheduledSection
                weekSection
                ProfileSection()
                ServerSection()
            }
            .navigationTitle("Schedule")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingAddBlock = true
                    } label: {
                        Label("Add block", systemImage: "plus")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .pipScreen()
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

    /// Display ordering only; the plan's ranking and suggested times remain untouched.
    private struct DayEntry: Identifiable {
        let id: String
        let time: String
        let block: TimetableBlock?
        let item: PlanItem?
    }

    private var flexibleItems: [PlanItem] {
        guard let plan = model.currentPlan else { return [] }
        return ([plan.doNow, plan.next].compactMap { $0 } + plan.today)
            .filter { $0.kind != .fixedBlock }
    }

    private var dayEntries: [DayEntry] {
        let fixed = todayBlocks.map { DayEntry(id: "class-" + $0.id, time: $0.startsAt, block: $0, item: nil) }
        let flexible = flexibleItems.compactMap { item -> DayEntry? in
            guard let startsAt = item.startsAt, startsAt.count >= 16 else { return nil }
            return DayEntry(id: item.itemId, time: String(startsAt.dropFirst(11).prefix(5)), block: nil, item: item)
        }
        return (fixed + flexible).sorted { $0.time == $1.time ? $0.id < $1.id : $0.time < $1.time }
    }

    private var todaySection: some View {
        Section {
            if let window = model.currentPlan?.freeWindowText ?? model.todayTimetable?.nextFreeWindow?.label {
                Label(window, systemImage: "hourglass")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PipDesign.accent)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if dayEntries.isEmpty {
                PipStatusView(symbol: "calendar", title: "Nothing scheduled today", detail: "Tap + to add a class.")
                    .padding(.vertical, 4)
            } else {
                ForEach(dayEntries) { entry in
                    if let block = entry.block {
                        TimelineBlockRow(block: block)
                    } else if let item = entry.item {
                        NavigationLink {
                            TaskDetailView(item: item, task: model.task(for: item), planNow: model.currentPlan?.reasoning.now)
                        } label: {
                            TimelineTaskRow(item: item)
                        }
                    }
                }
            }
        } header: {
            Text("Today")
        } footer: {
            Text("Classes are fixed. Task times are suggestions.")
        }
    }

    @ViewBuilder
    private var unscheduledSection: some View {
        let unscheduled = flexibleItems.filter { $0.startsAt == nil }
        if !unscheduled.isEmpty {
            Section("No time yet") {
                ForEach(unscheduled) { item in
                    NavigationLink {
                        TaskDetailView(item: item, task: model.task(for: item), planNow: model.currentPlan?.reasoning.now)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.title)
                                .font(.body.weight(.semibold))
                                .fixedSize(horizontal: false, vertical: true)
                            Text(item.action)
                                .font(.footnote)
                                .foregroundStyle(PipDesign.secondary)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                            if let flag = item.flag {
                                FlagPill(flag: flag)
                                    .padding(.top, 2)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
    }

    // MARK: Week

    @ViewBuilder
    private var weekSection: some View {
        Section {
            Button {
                showingAddBlock = true
            } label: {
                Label("Add block", systemImage: "plus.circle.fill")
                    .fontWeight(.semibold)
            }
        } header: {
            Text("Week")
        } footer: {
            if !model.weekTimetable.isEmpty {
                Text("Swipe left to delete.")
            }
        }
        ForEach(Array(1...7), id: \.self) { day in
            daySection(day)
        }
    }

    @ViewBuilder
    private func daySection(_ day: Int) -> some View {
        let dayBlocks = blocks(on: day)
        if !dayBlocks.isEmpty {
            Section {
                ForEach(dayBlocks) { block in
                    WeekBlockRow(block: block)
                }
                .onDelete { offsets in
                    deleteBlocks(on: day, at: offsets)
                }
            } header: {
                Text(DateFormatting.weekdayName(day))
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 2) {
                Text(DateFormatting.timeOfDay(block.startsAt))
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                Text(DateFormatting.timeOfDay(block.endsAt))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(PipDesign.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .frame(minWidth: typeSize.isAccessibilitySize ? nil : 76, alignment: .leading)

            VStack(alignment: .leading, spacing: 6) {
                Text(block.title)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                PipFlowLayout {
                    PipPill(text: "Class", systemImage: "lock.fill")
                    if let location = block.location, !location.isEmpty {
                        Text(location)
                            .font(.footnote)
                            .foregroundStyle(PipDesign.secondary)
                            .padding(.vertical, 4)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, stacked ? 0 : 16)
            .overlay(alignment: .leading) {
                if !stacked {
                    // Full-height rail marks a fixed class.
                    Capsule()
                        .fill(PipDesign.accent)
                        .frame(width: 3)
                        .frame(width: 7)
                }
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

private struct TimelineTaskRow: View {
    let item: PlanItem
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 2) {
                Text(DateFormatting.time(item.startsAt) ?? "Anytime")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                if let end = DateFormatting.time(item.endsAt) {
                    Text(end)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(PipDesign.secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .frame(minWidth: typeSize.isAccessibilitySize ? nil : 76, alignment: .leading)

            VStack(alignment: .leading, spacing: 6) {
                Text(item.title)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                PipFlowLayout {
                    PipPill(text: "Flexible", systemImage: "circle.dashed", tint: PipDesign.secondary)
                    if let flag = item.flag {
                        FlagPill(flag: flag)
                    }
                }
                Text(item.action)
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, stacked ? 0 : 16)
            .overlay(alignment: .topLeading) {
                if !stacked {
                    // Hollow ring marks a flexible, suggested time.
                    Circle()
                        .strokeBorder(PipDesign.accent, lineWidth: 1.5)
                        .frame(width: 7, height: 7)
                        .padding(.top, 8)
                }
            }
        }
        .padding(.vertical, 8)
    }
}

private struct WeekBlockRow: View {
    let block: TimetableBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(block.title)
                .font(.body.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Text(detail)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
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
                    Label("End must be after start.", systemImage: "exclamationmark.circle.fill")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(PipDesign.danger)
                        .fixedSize(horizontal: false, vertical: true)
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stacked = typeSize.isAccessibilitySize
        let cashLayout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout())
        Section {
            cashLayout {
                Text("Cash available")
                if !stacked {
                    Spacer()
                }
                HStack {
                    Text("$")
                        .foregroundStyle(PipDesign.secondary)
                    TextField("0", text: $cashText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(stacked ? .leading : .trailing)
                }
                .frame(maxWidth: stacked ? CGFloat.infinity : 110, alignment: stacked ? .leading : .trailing)
            }
            .onAppear {
                loadDraft()
            }
            .onChange(of: model.profile) { _, _ in
                loadDraft()
            }

            DatePicker("Budget until", selection: $budgetUntil, displayedComponents: .date)

            Toggle("Cooks own meals", isOn: $cooksOwnMeals)

            Picker("Peak energy", selection: $chronotype) {
                ForEach(Chronotype.known, id: \.self) { value in
                    Text(value.label).tag(value)
                }
            }

            Picker("Procrastinates on", selection: $procrastinatesOn) {
                Text("Nothing").tag(TaskCategory?.none)
                ForEach(TaskCategory.known, id: \.self) { value in
                    Text(value.label).tag(TaskCategory?.some(value))
                }
            }

            Button {
                save()
            } label: {
                HStack {
                    Text("Save")
                        .fontWeight(.semibold)
                    Spacer()
                    if isSaving {
                        ProgressView()
                    } else if let savedMessage {
                        Label(savedMessage, systemImage: "checkmark")
                            .labelStyle(PipCompactLabelStyle())
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(PipDesign.positive)
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
                    .foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
            Text("Use your laptop’s LAN IP. Offline uses local data.")
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
                    .foregroundStyle(PipDesign.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.subheadline)
    }
}

#Preview("Schedule") {
    ScheduleView()
        .environment(AppModel.preview())
}
