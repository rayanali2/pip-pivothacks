import SwiftUI

struct TodayPlanView: View {
    @Environment(AppModel.self) private var model

    @State private var showReminders = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Today")
                .pipScreen()
                .sheet(isPresented: $showReminders) { PipRemindersView(plan: model.currentPlan) }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showReminders = true } label: { Image(systemName: "bell") }
                            .accessibilityLabel("Reminders")
                    }
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
                    PipStatusView(symbol: "text.bubble", title: "A fresh start", detail: "Tell Pip your day to build a plan.")
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

                header

                if let diff = model.lastDiff {
                    WhatChangedBanner(headline: diff.headline)
                        .id(plan.planId)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                if model.pipState == .thinking {
                    PipStatusView(symbol: "", title: "Updating…", detail: "Checking your new window.", loading: true)
                        .pipCard()
                }

                if let doNow = plan.doNow {
                    TodayFocusCard(item: doNow, plan: plan)
                }

                DisclosureGroup {
                    PlanSaveActions(plan: plan).padding(.top, 8)
                } label: {
                    Label("Save & reminders", systemImage: "square.and.arrow.down")
                        .font(.subheadline.weight(.medium))
                }

                answerAndWarnings

                DisclosureGroup {
                    ContextSection().padding(.top, 12)
                } label: {
                    Label("Time check", systemImage: "clock.arrow.circlepath")
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
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text("YOUR FLOW").font(.caption2.weight(.bold)).tracking(1.6)
                    .foregroundStyle(PipDesign.secondary)
                Text("\(plan.allItems.filter { $0.kind != .fixedBlock }.count) tasks · \(plan.allItems.filter { $0.kind == .fixedBlock }.count) fixed")
                    .font(.subheadline.weight(.medium))
            }
            Spacer()
            SourceLabel(source: model.lastSource)
        }
    }

    @ViewBuilder
    private var answerAndWarnings: some View {
        if !plan.reasoning.warnings.isEmpty {
            DisclosureGroup {
                ForEach(Array(plan.reasoning.warnings.enumerated()), id: \.offset) { pair in
                    Text(pair.element.text).font(.footnote).padding(.vertical, 5)
                }
            } label: {
                PlanTag(text: "\(plan.reasoning.warnings.count) risk alert\(plan.reasoning.warnings.count == 1 ? "" : "s")", symbol: "exclamationmark.triangle", tint: PipDesign.warning)
            }
            .tint(PipDesign.warning)
        }
        if let answer = plan.reasoning.answer, !answer.isEmpty {
            PlanDisclosure(title: "Plan notes", text: answer)
        }
    }

}

struct WhatChangedBanner: View {
    let headline: String

    var body: some View {
        PlanDisclosure(title: "Plan updated", text: headline, symbol: "arrow.triangle.2.circlepath")
            .padding(.horizontal, 14).padding(.vertical, 4)
            .background(PipDesign.mist, in: RoundedRectangle(cornerRadius: 14))
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
            DisclosureGroup {
                Text(item.action).font(.subheadline).padding(.vertical, 6)
                Text(item.why).font(.footnote).foregroundStyle(PipDesign.secondary)
            } label: {
                PlanRow(item: item, planNow: planNow, highlighted: highlighted, showsChevron: false)
            }
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
            TaskGlyph(category: item.category, fixed: item.kind == .fixedBlock)
            VStack(alignment: .leading, spacing: 6) {
                Text(item.kind == .fixedBlock ? "FIXED" : item.category?.label.uppercased() ?? "TASK")
                    .font(.caption2.weight(.bold)).tracking(0.8).foregroundStyle(PipDesign.secondary)
                Text(item.title).font(.body.weight(.semibold)).foregroundStyle(PipDesign.ink)
                Text(item.timeLabel(relativeTo: planNow) ?? "When you have space")
                    .font(.footnote.monospacedDigit()).foregroundStyle(PipDesign.accent)
                if let flag = item.flag { FlagPill(flag: flag) }
                if highlighted {
                    Label("Moved", systemImage: "arrow.up.arrow.down")
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

    private let chips = [
        (label: "25 min", symbol: "timer", prompt: "I only have 25 minutes"),
        (label: "Budget", symbol: "creditcard", prompt: "What can I afford?"),
        (label: "Why this?", symbol: "questionmark.circle", prompt: "Why not my assignment?")
    ]

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 10) {
            if model.pipState == .listening && model.isFollowUpRecording { RecordingStatus() }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(chips, id: \.label) { chip in
                        Button { model.followUp(text: chip.prompt) } label: {
                            Label(chip.label, systemImage: chip.symbol)
                        }
                        .accessibilityLabel(chip.prompt)
                        .buttonStyle(ChipButtonStyle())
                        .disabled(model.isBusy)
                    }
                }
                .padding(.horizontal, 16)
            }

            HStack(alignment: .center, spacing: 10) {
                TextField("Adjust your plan…", text: $text, axis: .vertical)
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

/// The compact Today presentation is deliberately separate from Home's DoNowCard.
private struct TodayFocusCard: View {
    @Environment(AppModel.self) private var model
    let item: PlanItem
    let plan: Plan
    private var started: Bool { model.startNowConfirmation == item.itemId }
    private var available: Int? { plan.reasoning.context.availableMinutes ?? plan.reasoning.freeWindow?.minutes }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(started ? "IN MOTION" : "UP FIRST", systemImage: started ? "checkmark.circle.fill" : "sparkle")
                    .font(.caption.weight(.bold)).tracking(1)
                    .foregroundStyle(started ? PipDesign.positive : PipDesign.accent)
                Spacer()
                TaskGlyph(category: item.category, size: 42)
            }
            Text(item.title).font(.system(.title, design: .rounded, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)
            TaskMetadata(item: item, now: plan.reasoning.now)
            if let available, let used = PlanVisuals.windowMinutes(item) {
                WindowFitView(used: used, available: available)
            }
            if let window = plan.reasoning.freeWindow, let next = window.nextBlockTitle {
                Label("Before \(next)", systemImage: "graduationcap")
                    .font(.caption).foregroundStyle(PipDesign.secondary)
            }
            Button { model.startNow(item: item) } label: {
                Label(started ? "Started" : "Start now", systemImage: started ? "checkmark" : "play.fill")
            }
            .buttonStyle(PrimaryButtonStyle()).disabled(started)
            if item.opensDetail {
                NavigationLink {
                    TaskDetailView(item: item, task: model.task(for: item), planNow: plan.reasoning.now)
                } label: {
                    HStack {
                        Label("Steps & details", systemImage: "list.bullet")
                        Spacer()
                        Image(systemName: "arrow.up.right")
                    }
                    .font(.subheadline.weight(.medium)).frame(minHeight: 36)
                }
            } else {
                PlanDisclosure(title: "Next step", text: item.action)
            }
            PlanDisclosure(title: "Why first", text: item.why, symbol: "sparkle")
        }
        .pipCard(emphasized: true)
        .overlay {
            RoundedRectangle(cornerRadius: PipDesign.radius)
                .strokeBorder(model.highlightedItemIDs.contains(item.itemId) ? PipDesign.accent : .clear, lineWidth: 2)
        }
    }
}
