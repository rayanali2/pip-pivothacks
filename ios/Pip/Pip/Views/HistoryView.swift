import SwiftUI

struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @State private var mode: HistoryMode = .decisions
    @State private var actionsOnly = false

    enum HistoryMode: Hashable {
        case decisions
        case context
        case pivots
    }

    var body: some View {
        NavigationStack {
            List {
                HStack(spacing: 12) {
                    Button { actionsOnly = false; mode = .decisions } label: {
                        PlanTag(text: "\(model.history.count) decisions", symbol: "square.stack")
                    }
                    .accessibilityLabel("Show all decisions")
                    Button { actionsOnly.toggle(); mode = .decisions } label: {
                        PlanTag(text: "\(model.history.reduce(0) { $0 + $1.actions.count }) actions", symbol: actionsOnly ? "checkmark.circle.fill" : "checkmark.circle", tint: UniMateDesign.positive)
                    }
                    .accessibilityLabel(actionsOnly ? "Show all decisions" : "Show decisions with actions")
                }
                .buttonStyle(.plain)
                .listRowSeparator(.hidden).listRowBackground(Color.clear)
                if Config.isDemoMode && mode != .pivots {
                    Section {
                        Picker("View", selection: $mode) {
                            Text("Decisions").tag(HistoryMode.decisions)
                            Text("Context").tag(HistoryMode.context)
                        }
                        .pickerStyle(.segmented)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                }

                Section {
                    switch mode {
                    case .decisions:
                        decisionRows
                    case .context:
                        contextRows
                    case .pivots:
                        pivotRows
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .uniMateScreen()
            .navigationTitle(mode == .pivots ? "Pivot Log" : "History")
            .toolbar {
                if Config.isDemoMode {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(mode == .pivots ? "Decisions" : "Pivot Log") {
                            mode = mode == .pivots ? .decisions : .pivots
                        }
                        .font(.subheadline.weight(.semibold))
                        .tint(UniMateDesign.accent)
                    }
                }
            }
            .refreshable {
                await refresh()
            }
            .task {
                await refresh()
            }
        }
    }

    private var sortedHistory: [HistoryEntry] {
        model.history.filter { !actionsOnly || !$0.actions.isEmpty }.sorted { first, second in
            let a = DateFormatting.parse(first.createdAt) ?? Date.distantPast
            let b = DateFormatting.parse(second.createdAt) ?? Date.distantPast
            return a > b
        }
    }

    private var sortedPivots: [PivotLogEntry] {
        model.pivotLog.sorted { $0.pivotNumber < $1.pivotNumber }
    }

    @ViewBuilder
    private var decisionRows: some View {
        if sortedHistory.isEmpty {
            UniMateStatusView(symbol: "clock.arrow.circlepath", title: actionsOnly ? "No actions yet" : "No decisions yet", detail: actionsOnly ? "Tap Start now on a task." : "Talk to UniMate to make your first plan.")
                .padding(.vertical, 6)
                .listRowSeparator(.hidden)
                .listRowBackground(UniMateDesign.surface)
        } else {
            ForEach(sortedHistory) { entry in
                DecisionRow(entry: entry)
                    .listRowBackground(UniMateDesign.surface)
                    .listRowSeparatorTint(UniMateDesign.line)
            }
        }
    }

    @ViewBuilder
    private var contextRows: some View {
        if model.contextHistory.isEmpty {
            UniMateStatusView(symbol: "clock", title: "No context checks yet", detail: "Run a time check on Today.")
                .padding(.vertical, 6)
                .listRowSeparator(.hidden)
                .listRowBackground(UniMateDesign.surface)
        } else {
            ForEach(model.contextHistory) { entry in
                ContextHistoryRow(entry: entry)
                    .listRowBackground(UniMateDesign.surface)
                    .listRowSeparatorTint(UniMateDesign.line)
            }
        }
    }

    @ViewBuilder
    private var pivotRows: some View {
        if model.pivotLog.isEmpty {
            UniMateStatusView(symbol: "arrow.triangle.branch", title: "No pivots yet", detail: "Logged pivots show up here.")
                .padding(.vertical, 6)
                .listRowSeparator(.hidden)
                .listRowBackground(UniMateDesign.surface)
        } else {
            ForEach(sortedPivots) { entry in
                PivotRow(entry: entry)
                    .listRowBackground(UniMateDesign.surface)
                    .listRowSeparatorTint(UniMateDesign.line)
            }
        }
    }

    private func refresh() async {
        await model.refreshHistory()
        await model.refreshPivotLog()
        await model.refreshContextHistory()
    }
}

// MARK: - Timeline

/// Accent dot with a hairline rule down the leading edge of each history row.
private struct HistoryTimelineMark: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.vertical, 12)
            .padding(.leading, 16)
            .overlay(alignment: .leading) {
                VStack(spacing: 4) {
                    Circle().fill(UniMateDesign.accent).frame(width: 7, height: 7)
                    Rectangle().fill(UniMateDesign.line).frame(width: 1)
                }
                .padding(.top, 20)
                .padding(.bottom, 12)
                .accessibilityHidden(true)
            }
    }
}

private extension View {
    func historyTimelineMark() -> some View {
        modifier(HistoryTimelineMark())
    }
}

/// Time on the left, then short metadata pills; wraps on small screens and large text.
private struct HistoryRowHeader<Pills: View>: View {
    let time: String
    let pills: Pills

    init(time: String, @ViewBuilder pills: () -> Pills) {
        self.time = time
        self.pills = pills()
    }

    var body: some View {
        UniMateFlowLayout(spacing: 8) {
            Text(time)
                .font(.caption.monospacedDigit())
                .foregroundStyle(UniMateDesign.secondary)
                .padding(.vertical, 5)
            pills
        }
    }
}

// MARK: - Rows

/// The input context snapshot next to the recommendation it produced.
private struct ContextHistoryRow: View {
    let entry: ContextHistoryEntry

    var body: some View {
        let plan = entry.plan
        let s = plan.snapshot
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                PlanTag(text: "\(s.availableMinutes) min", symbol: "timer")
                Spacer()
                Text(DateFormatting.dayTime(entry.createdAt) ?? entry.createdAt)
                    .font(.caption).foregroundStyle(UniMateDesign.secondary)
            }
            Text(plan.doNow?.label ?? "No fit").font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            if !entry.actions.isEmpty {
                PlanTag(text: "Started", symbol: "checkmark", tint: UniMateDesign.positive)
            }
            DisclosureGroup {
                Text(inputLine(s)).font(.footnote).padding(.top, 6)
                Text(plan.reason).font(.footnote).padding(.vertical, 6)
                Text("\(plan.resultState.label) · \(plan.provenance.label)").font(.caption2)
            } label: {
                Label("Context snapshot", systemImage: "slider.horizontal.3").font(.caption.weight(.medium))
            }
            .foregroundStyle(UniMateDesign.secondary)
        }
        .padding(.vertical, 12)
    }

    private func inputLine(_ s: ContextSnapshot) -> String {
        var parts = ["Now \(ContextTimeFormatting.wallTime(s.now))"]
        if let next = s.nextCommitment {
            parts.append("\(next.title) \(ContextTimeFormatting.wallTime(next.startsAt))")
        }
        parts.append(s.statedMinutes.map { "free \(s.availableMinutes) (said \($0), computed \(s.computedFreeMinutes))" } ?? "free \(s.availableMinutes) min")
        parts.append("cash \(ContextMoneyFormatting.amount(s.money.cashCents, s.money.currency)), reserve \(ContextMoneyFormatting.amount(s.money.reserveCents, s.money.currency))")
        return parts.joined(separator: " · ")
    }

    private static func stateTint(_ state: ContextResultState) -> Color {
        switch state {
        case .feasible: return UniMateDesign.positive
        case .conditional: return UniMateDesign.warning
        case .conflict: return UniMateDesign.danger
        case .needsReview: return UniMateDesign.warning
        }
    }

    private static func stateSymbol(_ state: ContextResultState) -> String {
        switch state {
        case .feasible: return "checkmark.circle"
        case .conditional: return "exclamationmark.circle"
        case .conflict: return "xmark.circle"
        case .needsReview: return "questionmark.circle"
        }
    }

    private static func provenanceSymbol(_ provenance: ContextProvenance) -> String {
        switch provenance {
        case .liveSnowflake: return "snowflake"
        case .localFallback: return "internaldrive"
        case .seededDemo: return "tray"
        case .backupRecording: return "waveform"
        }
    }
}

private struct DecisionRow: View {
    let entry: HistoryEntry

    private var quote: String? {
        let question = entry.context?.question
        let candidate = entry.trigger == .rerank ? (question ?? entry.transcript) : (entry.transcript ?? question)
        guard let candidate, !candidate.isEmpty else { return nil }
        return candidate
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: entry.trigger == .rerank ? "arrow.triangle.2.circlepath" : "text.bubble.fill")
                .font(.subheadline).foregroundStyle(UniMateDesign.accent)
                .frame(width: 36, height: 36).background(UniMateDesign.mist, in: Circle())
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(entry.trigger == .rerank ? "PLAN UPDATED" : "PLAN CREATED")
                        .font(.caption2.weight(.bold)).tracking(0.8).foregroundStyle(UniMateDesign.accent)
                    Spacer()
                    Text(DateFormatting.dayTime(entry.createdAt) ?? entry.createdAt)
                        .font(.caption2).foregroundStyle(UniMateDesign.secondary)
                }
                Text(entry.doNowTitle ?? "Plan saved").font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                if let minutes = entry.context?.availableMinutes {
                    PlanTag(text: "\(minutes) min available", symbol: "timer")
                }
                if let last = entry.actions.last {
                    Label(last.kind.pastTenseLabel, systemImage: last.kind == .drop ? "xmark.circle" : "checkmark.circle")
                        .font(.caption.weight(.semibold)).foregroundStyle(last.kind == .done || last.kind == .startNow ? UniMateDesign.positive : UniMateDesign.secondary)
                }
                DisclosureGroup {
                    if let quote { Text("“\(quote)”").font(.subheadline).padding(.top, 6) }
                    if let cash = entry.context?.cashAvailable {
                        Label(MoneyFormatting.dollars(cash), systemImage: "creditcard").font(.footnote)
                    }
                    Text(entry.changed).font(.footnote).padding(.vertical, 6)
                    ForEach(Array(entry.actions.enumerated()), id: \.offset) { pair in
                        Text(Self.actionText(pair.element)).font(.footnote).padding(.bottom, 4)
                    }
                } label: {
                    Text("Decision details").font(.caption.weight(.medium)).frame(minHeight: 30)
                }
                .foregroundStyle(UniMateDesign.secondary)
            }
        }
        .padding(.vertical, 14)
    }

    private static func actionText(_ action: HistoryAction) -> String {
        var text = action.kind.pastTenseLabel
        if let title = action.taskTitle, !title.isEmpty {
            text += ": \(title)"
        }
        if let time = DateFormatting.time(action.createdAt) {
            text += " · \(time)"
        }
        return text
    }
}

private struct PivotRow: View {
    let entry: PivotLogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pivot \(entry.pivotNumber)")
                .font(.headline)
            DisclosureGroup("Explore pivot") {
            PivotField(label: "Revealed", text: entry.revealed)
            PivotField(label: "Assumption changed", text: entry.assumptionChanged)
            PivotField(label: "Response", text: entry.response)
            PivotField(label: "Cut", text: entry.cut)
            if let sentence = entry.sentence, !sentence.isEmpty {
                Text(sentence)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(UniMateDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            }
        }
        .historyTimelineMark()
    }
}

private struct PivotField: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .uniMateEyebrow()
            Text(text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

#Preview("History") {
    HistoryView()
        .environment(AppModel.preview())
}
