import SwiftUI

struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @State private var mode: HistoryMode = .decisions

    enum HistoryMode: Hashable {
        case decisions
        case context
        case pivots
    }

    var body: some View {
        NavigationStack {
            List {
                if mode != .pivots {
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
            .pipScreen()
            .navigationTitle(mode == .pivots ? "Pivot Log" : "History")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(mode == .pivots ? "Decisions" : "Pivot Log") {
                        mode = mode == .pivots ? .decisions : .pivots
                    }
                    .font(.subheadline.weight(.semibold))
                    .tint(PipDesign.accent)
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
        model.history.sorted { first, second in
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
        if model.history.isEmpty {
            PipStatusView(symbol: "clock.arrow.circlepath", title: "No decisions yet", detail: "Talk to Pip to make your first plan.")
                .padding(.vertical, 6)
                .listRowSeparator(.hidden)
                .listRowBackground(PipDesign.surface)
        } else {
            ForEach(sortedHistory) { entry in
                DecisionRow(entry: entry)
                    .listRowBackground(PipDesign.surface)
                    .listRowSeparatorTint(PipDesign.line)
            }
        }
    }

    @ViewBuilder
    private var contextRows: some View {
        if model.contextHistory.isEmpty {
            PipStatusView(symbol: "clock", title: "No context checks yet", detail: "Run a time check on Today.")
                .padding(.vertical, 6)
                .listRowSeparator(.hidden)
                .listRowBackground(PipDesign.surface)
        } else {
            ForEach(model.contextHistory) { entry in
                ContextHistoryRow(entry: entry)
                    .listRowBackground(PipDesign.surface)
                    .listRowSeparatorTint(PipDesign.line)
            }
        }
    }

    @ViewBuilder
    private var pivotRows: some View {
        if model.pivotLog.isEmpty {
            PipStatusView(symbol: "arrow.triangle.branch", title: "No pivots yet", detail: "Logged pivots show up here.")
                .padding(.vertical, 6)
                .listRowSeparator(.hidden)
                .listRowBackground(PipDesign.surface)
        } else {
            ForEach(sortedPivots) { entry in
                PivotRow(entry: entry)
                    .listRowBackground(PipDesign.surface)
                    .listRowSeparatorTint(PipDesign.line)
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
                    Circle().fill(PipDesign.accent).frame(width: 7, height: 7)
                    Rectangle().fill(PipDesign.line).frame(width: 1)
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
        PipFlowLayout(spacing: 8) {
            Text(time)
                .font(.caption.monospacedDigit())
                .foregroundStyle(PipDesign.secondary)
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
        VStack(alignment: .leading, spacing: 8) {
            HistoryRowHeader(time: DateFormatting.dayTime(entry.createdAt) ?? entry.createdAt) {
                PipPill(text: plan.resultState.label, systemImage: Self.stateSymbol(plan.resultState), tint: Self.stateTint(plan.resultState))
                PipPill(text: plan.provenance.label, systemImage: Self.provenanceSymbol(plan.provenance), tint: PipDesign.secondary)
            }
            Text("Do now: \(plan.doNow?.label ?? "nothing fits")")
                .font(.body.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(plan.reason)
                .font(.footnote)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(inputLine(s))
                .font(.caption.monospacedDigit())
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !entry.actions.isEmpty {
                Label {
                    Text("Started · \(entry.actions.count == 1 ? "1 action" : "\(entry.actions.count) actions")")
                        .foregroundStyle(PipDesign.secondary)
                } icon: {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(PipDesign.positive)
                }
                .font(.footnote)
            }
        }
        .historyTimelineMark()
        .accessibilityElement(children: .combine)
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
        case .feasible: return PipDesign.positive
        case .conditional: return PipDesign.warning
        case .conflict: return PipDesign.danger
        case .needsReview: return PipDesign.warning
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
        VStack(alignment: .leading, spacing: 8) {
            HistoryRowHeader(time: DateFormatting.dayTime(entry.createdAt) ?? entry.createdAt) {
                PipPill(text: entry.trigger.label)
                if let minutes = entry.context?.availableMinutes {
                    PipPill(text: "\(minutes) min free", systemImage: "clock")
                }
                if let cash = entry.context?.cashAvailable {
                    PipPill(text: MoneyFormatting.dollars(cash), systemImage: "wallet.bifold", tint: PipDesign.secondary)
                }
            }

            if let title = entry.doNowTitle {
                Text("Do now: \(title)")
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let quote {
                Text("“\(quote)”")
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(entry.changed)
                .font(.footnote)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if !entry.actions.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(entry.actions.enumerated()), id: \.offset) { pair in
                        Label {
                            Text(Self.actionText(pair.element))
                                .foregroundStyle(PipDesign.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: Self.actionIcon(pair.element.kind).0)
                                .foregroundStyle(Self.actionIcon(pair.element.kind).1)
                        }
                        .font(.footnote)
                    }
                }
            }
        }
        .historyTimelineMark()
        .accessibilityElement(children: .combine)
    }

    private static func actionIcon(_ kind: ActionKind) -> (String, Color) {
        switch kind {
        case .startNow: return ("play.circle.fill", PipDesign.accent)
        case .done: return ("checkmark.circle.fill", PipDesign.positive)
        case .deferTask: return ("arrow.uturn.forward.circle", PipDesign.secondary)
        case .drop: return ("xmark.circle", PipDesign.secondary)
        case .unknown: return ("circle", PipDesign.secondary)
        }
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
            PivotField(label: "Revealed", text: entry.revealed)
            PivotField(label: "Assumption changed", text: entry.assumptionChanged)
            PivotField(label: "Response", text: entry.response)
            PivotField(label: "Cut", text: entry.cut)
            if let sentence = entry.sentence, !sentence.isEmpty {
                Text(sentence)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .historyTimelineMark()
        .accessibilityElement(children: .combine)
    }
}

private struct PivotField: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .pipEyebrow()
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
