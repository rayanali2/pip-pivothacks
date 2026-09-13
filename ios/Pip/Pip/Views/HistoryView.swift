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
                Picker("View", selection: $mode) {
                    Text("Decisions").tag(HistoryMode.decisions)
                    Text("Context").tag(HistoryMode.context)
                    Text("Pivot Log").tag(HistoryMode.pivots)
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)

                switch mode {
                case .decisions:
                    decisionRows
                case .context:
                    contextRows
                case .pivots:
                    pivotRows
                }
            }
            .listStyle(.plain)
            .navigationTitle("History")
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
            Text("No decisions yet. Talk to Pip to make your first plan.")
                .foregroundStyle(.secondary)
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
            Text("No context plans yet. Change free time on Today.")
                .foregroundStyle(.secondary)
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
                .foregroundStyle(.secondary)
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
                    .foregroundStyle(.secondary)
                Text("rev \(s.revision)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Spacer(minLength: 4)
                Text("\(plan.resultState.label) · \(plan.provenance.label)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Text(inputLine(s))
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Do now: \(plan.doNow?.label ?? "nothing fits")")
                .font(.body.weight(.semibold))
            Text(plan.reason)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !entry.actions.isEmpty {
                Label("Started · \(entry.actions.count == 1 ? "1 action" : "\(entry.actions.count) actions")", systemImage: "checkmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
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
                    .foregroundStyle(.secondary)
                Text(entry.trigger.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Spacer(minLength: 4)
                Text(entry.model)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            if let quote {
                Text("“\(quote)”")
                    .font(.subheadline)
                    .lineLimit(3)
            }

            if let title = entry.doNowTitle {
                Text("Do now: \(title)")
                    .font(.body.weight(.semibold))
            }

            Text(entry.changed)
                .font(.footnote)
                .foregroundStyle(.secondary)

            ForEach(Array(entry.actions.enumerated()), id: \.offset) { pair in
                Label(Self.actionText(pair.element), systemImage: "checkmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
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
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct PivotField: View {
    let label: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
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
