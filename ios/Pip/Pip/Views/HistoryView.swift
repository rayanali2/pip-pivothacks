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
                SectionHeading(title: "Small steps, remembered.", subtitle: "What you chose, and why it made sense.")
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                if mode != .pivots {
                Picker("View", selection: $mode) {
                    Text("Decisions").tag(HistoryMode.decisions)
                    Text("Context").tag(HistoryMode.context)
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                }

                switch mode {
                case .decisions:
                    decisionRows
                case .context:
                    contextRows
                case .pivots:
                    pivotRows
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .pipScreen()
            .navigationTitle(mode == .pivots ? "Pivot Log" : "History")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(mode == .pivots ? "Decisions" : "Pivot Log") {
                        mode = mode == .pivots ? .decisions : .pivots
                    }
                    .font(.subheadline)
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
            PipStatusView(symbol: "clock.arrow.circlepath", title: "Your first step starts here", detail: "Talk to Pip to make a plan. Your decisions and actions will be saved here.")
                .listRowSeparator(.hidden)
        } else {
            ForEach(sortedHistory) { entry in
                DecisionRow(entry: entry)
            }
        }
    }

    @ViewBuilder
    private var contextRows: some View {
        if model.contextHistory.isEmpty {
            PipStatusView(symbol: "clock", title: "No context checks yet", detail: "Check your time before class on Today to save a recommendation and its context.")
                .listRowSeparator(.hidden)
        } else {
            ForEach(model.contextHistory) { entry in
                ContextHistoryRow(entry: entry)
            }
        }
    }

    @ViewBuilder
    private var pivotRows: some View {
        if model.pivotLog.isEmpty {
            Text("No pivots logged yet.")
                .foregroundStyle(PipDesign.secondary)
                .listRowSeparator(.hidden)
        } else {
            ForEach(sortedPivots) { entry in
                PivotRow(entry: entry)
            }
        }
    }

    private func refresh() async {
        await model.refreshHistory()
        await model.refreshPivotLog()
        await model.refreshContextHistory()
    }
}

/// The input context snapshot next to the recommendation it produced.
private struct ContextHistoryRow: View {
    let entry: ContextHistoryEntry

    var body: some View {
        let plan = entry.plan
        let s = plan.snapshot
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(DateFormatting.dayTime(entry.createdAt) ?? entry.createdAt)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(PipDesign.secondary)
                Spacer(minLength: 4)
                Text("\(plan.resultState.label) · \(plan.provenance.label)")
                    .font(.caption2)
                    .foregroundStyle(PipDesign.secondary)
            }
            Text(inputLine(s))
                .font(.footnote.monospacedDigit())
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Do now: \(plan.doNow?.label ?? "nothing fits")")
                .font(.body.weight(.semibold))
            Text(plan.reason)
                .font(.footnote)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !entry.actions.isEmpty {
                Label("Started · \(entry.actions.count == 1 ? "1 action" : "\(entry.actions.count) actions")", systemImage: "checkmark.circle")
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
            }
        }
        .padding(.vertical, 12)
        .padding(.leading, 16)
        .overlay(alignment: .leading) {
            VStack(spacing: 5) {
                Circle().fill(PipDesign.accent).frame(width: 7, height: 7)
                Rectangle().fill(PipDesign.line).frame(width: 1)
            }
            .padding(.vertical, 14)
        }
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
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(DateFormatting.dayTime(entry.createdAt) ?? entry.createdAt)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(PipDesign.secondary)
                Text(entry.trigger.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Spacer(minLength: 4)

            }

            if let title = entry.doNowTitle {
                Text("Do now: \(title)")
                    .font(.body.weight(.semibold))
            }

            if let quote {
                Text("“\(quote)”").font(.subheadline).foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let context = entry.context {
                HStack(spacing: 12) {
                    if let minutes = context.availableMinutes {
                        Label("\(minutes) min available", systemImage: "clock")
                    }
                    if let cash = context.cashAvailable {
                        Label(MoneyFormatting.dollars(cash), systemImage: "wallet.bifold")
                    }
                }
                .font(.footnote).foregroundStyle(PipDesign.accent)
            }

            Text(entry.changed)
                .font(.footnote)
                .foregroundStyle(PipDesign.secondary)

            ForEach(Array(entry.actions.enumerated()), id: \.offset) { pair in
                Label(Self.actionText(pair.element), systemImage: "checkmark.circle")
                    .font(.footnote)
                    .foregroundStyle(PipDesign.secondary)
            }
        }
        .padding(.vertical, 12)
        .padding(.leading, 16)
        .overlay(alignment: .leading) {
            VStack(spacing: 5) {
                Circle().fill(PipDesign.accent).frame(width: 7, height: 7)
                Rectangle().fill(PipDesign.line).frame(width: 1)
            }
            .padding(.vertical, 14)
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
        VStack(alignment: .leading, spacing: 8) {
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
            }
        }
        .padding(.vertical, 12)
        .padding(.leading, 16)
        .overlay(alignment: .leading) {
            VStack(spacing: 5) {
                Circle().fill(PipDesign.accent).frame(width: 7, height: 7)
                Rectangle().fill(PipDesign.line).frame(width: 1)
            }
            .padding(.vertical, 14)
        }
    }
}

private struct PivotField: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(PipDesign.secondary)
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
