import SwiftUI

struct TodayPlanView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Today")
                .pipScreen()
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
                    PipStatusView(symbol: "text.bubble", title: "Make room for what matters", detail: "Tell Pip about your day to turn everything on your mind into one next step.")
                        .pipCard()
                    Button("Talk to Pip") { model.selectedTab = .home }
                        .buttonStyle(PrimaryButtonStyle())
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let plan: Plan

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SectionHeading(title: "One thing at a time.", subtitle: "Start here. The rest has a place.")
                header

                if let diff = model.lastDiff {
                    WhatChangedBanner(headline: diff.headline)
                        .id(plan.planId)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                if model.pipState == .thinking {
                    PipStatusView(symbol: "", title: "Updating your plan", detail: "Checking what fits your new constraints…", loading: true)
                        .pipCard()
                }

                if let doNow = plan.doNow {
                    DoNowCard(item: doNow, planNow: plan.reasoning.now)
                }

                answerAndWarnings

                DisclosureGroup {
                    ContextSection().padding(.top, 12)
                } label: {
                    Label("Check time before class", systemImage: "clock.arrow.circlepath")
                        .font(.subheadline.weight(.semibold))
                }
                .pipCard()

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
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: plan.planId)
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
                        .foregroundStyle(PipDesign.warning)
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
        .padding(14)
        .background(PipDesign.mist, in: RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .leading) {
            Capsule()
                .fill(Color.accentColor)
                .frame(width: 3)
        }
    }
}

/// Shared by Home and Today; actions still use the original AppModel path.
struct DoNowCard: View {
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
                Label("Do this now", systemImage: "sparkle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                Spacer()
                if let flag = item.flag {
                    FlagPill(flag: flag)
                }
            }

            Text(item.title)
                .font(.system(.title, design: .rounded, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)

            Text(item.action)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)

            Text(item.why)
                .font(.subheadline)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let dueText {
                Text(dueText)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(PipDesign.secondary)
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
                    .foregroundStyle(PipDesign.secondary)
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
                .frame(minHeight: 44)
                }
            }
        }
        .pipCard(emphasized: true)
        .overlay {
            RoundedRectangle(cornerRadius: PipDesign.radius)
                .strokeBorder(isHighlighted ? PipDesign.accent : .clear, lineWidth: 2)
        }
    }
}

private struct PlanSectionList: View {
    @Environment(AppModel.self) private var model
    let title: String
    let items: [PlanItem]
    let planNow: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).font(PipDesign.heading)
                Spacer()
                Text("\(items.count)").font(.caption.weight(.semibold))
                    .foregroundStyle(PipDesign.secondary)
            }
            .padding(.bottom, 10)

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

struct PlanRow: View {
    let item: PlanItem
    let planNow: String
    let highlighted: Bool
    let showsChevron: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.kind == .fixedBlock ? "lock.fill" : "circle.dotted")
                .font(.subheadline)
                .foregroundStyle(PipDesign.accent)
                .frame(width: 34, height: 34)
                .background(PipDesign.mist, in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 6) {
                Text(item.kind == .fixedBlock ? "FIXED CLASS" : "FLEXIBLE TASK")
                    .font(.caption2.weight(.bold)).tracking(0.8).foregroundStyle(PipDesign.secondary)
                Text(item.title).font(.body.weight(.semibold)).foregroundStyle(PipDesign.ink)
                Text(item.timeLabel(relativeTo: planNow) ?? "When you have space")
                    .font(.footnote.monospacedDigit()).foregroundStyle(PipDesign.accent)
                Text(item.why).font(.subheadline).foregroundStyle(PipDesign.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if item.kind == .fixedBlock {
                    Text(item.action).font(.footnote).foregroundStyle(PipDesign.secondary)
                }
                if let flag = item.flag { FlagPill(flag: flag) }
                if highlighted {
                    Label("Updated in this plan", systemImage: "arrow.up.arrow.down")
                        .font(.caption.weight(.semibold)).foregroundStyle(PipDesign.accent)
                }
            }
            Spacer(minLength: 0)
            if showsChevron {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(PipDesign.secondary).padding(.top, 10)
            }
        }
        .padding(16)
        .background(highlighted ? PipDesign.mist : Color.white, in: RoundedRectangle(cornerRadius: 18))
        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(PipDesign.line) }
        .padding(.vertical, 5)
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
            if model.pipState == .listening && model.isFollowUpRecording { RecordingStatus() }
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
                    diameter: 44,
                    onPress: { model.startFollowUpVoice() },
                    onRelease: { model.stopRecordingAndSend() }
                )
                .disabled(model.pipState == .thinking)

                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 32))
                        .frame(width: 44, height: 44)
                }
                .disabled(trimmed.isEmpty || model.isBusy)
                .accessibilityLabel("Send follow-up")
            }
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 10)
        .background(PipDesign.background)
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
