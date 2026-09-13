import SwiftUI

struct TodayPlanView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Today")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            model.toggleMute()
                        } label: {
                            Image(systemName: model.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                        }
                        .accessibilityLabel(model.isMuted ? "Unmute Pip" : "Mute Pip")
                    }
                }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: model.currentPlan?.doNow?.itemId)
    }

    @ViewBuilder
    private var content: some View {
        if let plan = model.currentPlan {
            PlanScrollView(plan: plan)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    FollowUpBar()
                }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ContextSection()
                    ContentUnavailableView(
                        "No voice plan yet",
                        systemImage: "bird",
                        description: Text("Tell Pip about your day on the Pip tab")
                    )
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
        }
    }
}

// MARK: - Plan

private struct PlanScrollView: View {
    @Environment(AppModel.self) private var model
    let plan: Plan

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ContextSection()

                Divider()

                Text("From your voice plan")
                    .font(.headline)

                header

                if let diff = model.lastDiff {
                    WhatChangedBanner(headline: diff.headline)
                        .id(plan.planId)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                answerAndWarnings

                if let doNow = plan.doNow {
                    DoNowCard(item: doNow, planNow: plan.reasoning.now)
                }

                if let next = plan.next {
                    PlanSectionList(title: "Next", items: [next], planNow: plan.reasoning.now)
                }

                if !plan.today.isEmpty {
                    PlanSectionList(title: "Today", items: plan.today, planNow: plan.reasoning.now)
                }

                if !plan.canWait.isEmpty {
                    PlanSectionList(title: "Can wait", items: plan.canWait, planNow: plan.reasoning.now)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .animation(.spring(response: 0.45, dampingFraction: 0.85), value: plan.planId)
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            if let text = plan.freeWindowText {
                FreeWindowPill(text: text)
            }
            Spacer(minLength: 8)
            if model.pipState == .thinking {
                ProgressView()
                    .controlSize(.small)
            }
            SourceLabel(source: model.lastSource)
        }
    }

    @ViewBuilder
    private var answerAndWarnings: some View {
        if let answer = plan.reasoning.answer, !answer.isEmpty {
            Text(answer)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        if !plan.reasoning.warnings.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(plan.reasoning.warnings.enumerated()), id: \.offset) { pair in
                    Label(pair.element.text, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Color.red)
                }
            }
        }
    }
}

struct WhatChangedBanner: View {
    let headline: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("What changed")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Text(headline)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .padding(.leading, 14)
        .overlay(alignment: .leading) {
            Capsule()
                .fill(Color.accentColor)
                .frame(width: 3)
        }
    }
}

/// The only filled card on the screen.
private struct DoNowCard: View {
    @Environment(AppModel.self) private var model
    let item: PlanItem
    let planNow: String

    private var isHighlighted: Bool {
        model.highlightedItemIDs.contains(item.itemId)
    }

    private var isStarted: Bool {
        model.startNowConfirmation == item.itemId
    }

    private var dueText: String? {
        guard let dueAt = item.dueAt, let time = DateFormatting.smartTime(dueAt, relativeTo: planNow) else {
            return nil
        }
        var text = "Due \(time)"
        if let relative = DateFormatting.relative(dueAt, from: planNow) {
            text += " · \(relative)"
        }
        if let money = item.moneyAtRisk, money > 0 {
            text += " · \(MoneyFormatting.dollars(money)) at risk"
        }
        return text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Do now")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Spacer()
                if let flag = item.flag {
                    FlagPill(flag: flag)
                }
            }

            Text(item.title)
                .font(.title.bold())
                .fixedSize(horizontal: false, vertical: true)

            Text(item.action)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)

            Text(item.why)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let dueText {
                Text(dueText)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Button {
                model.startNow(item: item)
            } label: {
                Label(isStarted ? "Started" : "Start now", systemImage: isStarted ? "checkmark" : "play.fill")
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isStarted)
            .padding(.top, 4)

            if isStarted {
                Label("Started · saved to History", systemImage: "checkmark")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            }

            if item.opensDetail {
                NavigationLink {
                    TaskDetailView(item: item, task: model.task(for: item), planNow: planNow)
                } label: {
                    HStack(spacing: 4) {
                        Text("Why this is first")
                        Image(systemName: "chevron.right")
                    }
                    .font(.footnote.weight(.medium))
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color.accentColor.opacity(isHighlighted ? 0.2 : 0.1))
        )
    }
}

private struct PlanSectionList: View {
    @Environment(AppModel.self) private var model
    let title: String
    let items: [PlanItem]
    let planNow: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.headline)
                .padding(.bottom, 6)

            ForEach(items) { item in
                VStack(spacing: 0) {
                    if item.itemId != items.first?.itemId {
                        Divider()
                    }
                    row(for: item)
                }
                .transition(.opacity.combined(with: .move(edge: .leading)))
            }
        }
    }

    @ViewBuilder
    private func row(for item: PlanItem) -> some View {
        let highlighted = model.highlightedItemIDs.contains(item.itemId)
        if item.opensDetail {
            NavigationLink {
                TaskDetailView(item: item, task: model.task(for: item), planNow: planNow)
            } label: {
                PlanRow(item: item, planNow: planNow, highlighted: highlighted, showsChevron: true)
            }
            .buttonStyle(.plain)
        } else {
            PlanRow(item: item, planNow: planNow, highlighted: highlighted, showsChevron: false)
        }
    }
}

private struct PlanRow: View {
    let item: PlanItem
    let planNow: String
    let highlighted: Bool
    let showsChevron: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(item.timeLabel(relativeTo: planNow) ?? "Anytime")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 78, alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                if item.kind == .fixedBlock {
                    Text(item.action)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(item.why)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let flag = item.flag {
                    FlagPill(flag: flag)
                        .padding(.top, 2)
                }
            }

            Spacer(minLength: 0)

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(highlighted ? Color.accentColor.opacity(0.14) : Color.clear)
        )
        .contentShape(Rectangle())
    }
}

// MARK: - Follow-up bar

private struct FollowUpBar: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @FocusState private var focused: Bool

    private let chips = ["I only have 25 minutes", "What can I afford?", "Why not my assignment?"]

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(chips, id: \.self) { chip in
                        Button(chip) {
                            model.followUp(text: chip)
                        }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(model.isBusy)
                    }
                }
                .padding(.horizontal, 16)
            }

            HStack(alignment: .center, spacing: 10) {
                TextField("Ask Pip or add a constraint…", text: $text, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($focused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.pipField)
                    )

                HoldToTalkButton(
                    isListening: model.pipState == .listening && model.isFollowUpRecording,
                    diameter: 40,
                    onPress: { model.startFollowUpVoice() },
                    onRelease: { model.stopRecordingAndSend() }
                )

                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                }
                .disabled(trimmed.isEmpty || model.isBusy)
                .accessibilityLabel("Send follow-up")
            }
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func send() {
        let question = trimmed
        guard !question.isEmpty else { return }
        model.followUp(text: question)
        text = ""
        focused = false
    }
}

#Preview("Today plan") {
    TodayPlanView()
        .environment(AppModel.preview())
}
