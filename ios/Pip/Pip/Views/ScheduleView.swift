import SwiftUI

struct ScheduleView: View {
    @Environment(AppModel.self) private var model
    @State private var showingAddBlock = false
    @State private var timelineFilter: TimelineFilter = .all
    private enum TimelineFilter { case all, fixed, flexible }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 10) {
                        Button { timelineFilter = timelineFilter == .fixed ? .all : .fixed } label: {
                            PlanTag(text: "\(todayBlocks.count) fixed", symbol: timelineFilter == .fixed ? "lock.fill" : "lock")
                        }
                        .accessibilityLabel(timelineFilter == .fixed ? "Show all blocks" : "Show fixed classes")
                        Button { timelineFilter = timelineFilter == .flexible ? .all : .flexible } label: {
                            PlanTag(text: "\(flexibleItems.count) flexible", symbol: timelineFilter == .flexible ? "checkmark.circle.fill" : "circle.dotted")
                        }
                        .accessibilityLabel(timelineFilter == .flexible ? "Show all blocks" : "Show flexible tasks")
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                }
                todaySection
                unscheduledSection
                weekSection
                ProfileSection()
                ServerSection()
            }
            .navigationTitle("Schedule")
            .scrollContentBackground(.hidden)
            .uniMateScreen()
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
        return (fixed + flexible)
            .filter { timelineFilter == .all || (timelineFilter == .fixed ? $0.block != nil : $0.item != nil) }
            .sorted { $0.time == $1.time ? $0.id < $1.id : $0.time < $1.time }
    }

    private var todaySection: some View {
        Section {
            if let window = model.currentPlan?.freeWindowText ?? model.todayTimetable?.nextFreeWindow?.label {
                Label(window, systemImage: "clock")
                    .font(.subheadline.weight(.medium)).foregroundStyle(UniMateDesign.accent)
            }
            if dayEntries.isEmpty {
                UniMateStatusView(symbol: "calendar", title: "Room to shape your day", detail: "No scheduled blocks yet. Talk to UniMate or add a class below.")
            } else {
                ForEach(dayEntries) { entry in
                    if let block = entry.block {
                        DisclosureGroup {
                            Label(block.location ?? "No location added", systemImage: "mappin.and.ellipse")
                                .font(.subheadline).foregroundStyle(UniMateDesign.secondary)
                                .padding(.vertical, 8)
                        } label: {
                            TimelineBlockRow(block: block)
                        }
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
            Text(timelineFilter == .all ? "Day flow" : timelineFilter == .fixed ? "Fixed classes · tap filter to clear" : "Flexible tasks · tap filter to clear")
        } footer: {
            Label("Fixed classes · flexible task windows", systemImage: "info.circle")
        }
    }

    @ViewBuilder
    private var unscheduledSection: some View {
        let unscheduled = flexibleItems.filter { $0.startsAt == nil }
        if !unscheduled.isEmpty && timelineFilter != .fixed {
            Section("Find a window") {
                ForEach(unscheduled) { item in
                    NavigationLink {
                        TaskDetailView(item: item, task: model.task(for: item), planNow: model.currentPlan?.reasoning.now)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.title).font(.subheadline.weight(.semibold))
                            Text(item.timeLabel(relativeTo: model.currentPlan?.reasoning.now) ?? "Unscheduled")
                                .font(.caption).foregroundStyle(UniMateDesign.secondary)
                            if let flag = item.flag { FlagPill(flag: flag) }
                        }
                        .padding(.vertical, 6)
                    }
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
                .foregroundStyle(UniMateDesign.secondary)
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 2) {
                Text(DateFormatting.timeOfDay(block.startsAt))
                    .font(.subheadline.monospacedDigit())
                Text(DateFormatting.timeOfDay(block.endsAt))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(UniMateDesign.secondary)
            }
            .frame(width: typeSize.isAccessibilitySize ? nil : 76, alignment: .leading)

            Capsule()
                .fill(Color.accentColor)
                .frame(width: 3, height: 36)

            VStack(alignment: .leading, spacing: 5) {
                Label("FIXED", systemImage: "lock.fill")
                    .font(.caption2.weight(.bold)).foregroundStyle(UniMateDesign.accent)
                Text(block.title)
                    .font(.body.weight(.medium))
            }
        }
        .padding(.vertical, 10)
    }
}

private struct TimelineTaskRow: View {
    let item: PlanItem
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 3) {
                Text(DateFormatting.time(item.startsAt) ?? "Anytime")
                    .font(.subheadline.monospacedDigit())
                if let end = DateFormatting.time(item.endsAt) {
                    Text(end).font(.caption.monospacedDigit()).foregroundStyle(UniMateDesign.secondary)
                }
            }
            .frame(width: typeSize.isAccessibilitySize ? nil : 76, alignment: .leading)
            TaskGlyph(category: item.category, size: 34)
            VStack(alignment: .leading, spacing: 5) {
                Text(item.category?.label.uppercased() ?? "FLEXIBLE").font(.caption2.weight(.bold)).foregroundStyle(UniMateDesign.accent)
                Text(item.title).font(.body.weight(.medium))
                if let minutes = PlanVisuals.windowMinutes(item) {
                    Label("\(minutes) min", systemImage: "timer")
                        .font(.caption).foregroundStyle(UniMateDesign.secondary)
                }
            }
        }
        .padding(.vertical, 10)
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
                .foregroundStyle(UniMateDesign.secondary)
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
                    .foregroundStyle(UniMateDesign.secondary)
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
                            .foregroundStyle(UniMateDesign.secondary)
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
                    .foregroundStyle(UniMateDesign.secondary)
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
            Text("On a phone, use your laptop's LAN IP, e.g. http://192.168.1.20:3000. If the server can't be reached, UniMate uses local fallback data.")
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
