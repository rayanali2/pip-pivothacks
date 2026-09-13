import SwiftUI

struct TodayPlanView: View {
    @Environment(AppModel.self) private var model

    @State private var showReminders = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Today")
                .navigationBarTitleDisplayMode(.inline)
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
                VStack(alignment: .leading, spacing: PipDesign.gap) {
                    ContextSection()
                    VStack(spacing: 10) {
                        PenguinView(state: .idle, size: 60)
                            .accessibilityHidden(true)
                        Text("No plan yet").font(PipDesign.heading)
                        Text("Tell Pip about your day to get one next step.")
                            .font(.subheadline).foregroundStyle(PipDesign.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                        Button { model.selectedTab = .home } label: {
                            Label("Talk to Pip", systemImage: "mic.fill")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .padding(.top, 6)
                    }
                    .frame(maxWidth: .infinity)
                    .pipCard()
                }
                .padding(.horizontal, PipDesign.page)
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
            VStack(alignment: .leading, spacing: PipDesign.gap) {
                header

                if let diff = model.lastDiff {
                    WhatChangedBanner(headline: diff.headline)
                        .id(plan.planId)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                if model.pipState == .thinking {
                    PipStatusView(symbol: "", title: "Updating your plan", detail: "Checking what fits now", loading: true)
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
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }

                answerAndWarnings

                // The timeline's free-time control replaces the separate context check, so Today has one do-now.
                DayTimelineView(plan: plan)

                if !plan.canWait.isEmpty {
                    PlanSectionList(title: "Can wait", items: plan.canWait, planNow: plan.reasoning.now)
                }
            }
            .padding(.horizontal, PipDesign.page)
            .padding(.vertical, 12)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: plan.planId)
        }
    }

    private var header: some View {
        PipFlowLayout(spacing: 8, lineSpacing: 8) {
            if let text = plan.freeWindowText {
                FreeWindowPill(text: text)
            }
            Text("\(plan.allItems.filter { $0.kind != .fixedBlock }.count) tasks · \(plan.allItems.filter { $0.kind == .fixedBlock }.count) fixed")
                .font(.footnote.weight(.medium).monospacedDigit())
                .foregroundStyle(PipDesign.secondary)
                .padding(.vertical, 6)
            if model.pipState == .thinking {
                ProgressView()
                    .controlSize(.small)
                    .padding(.vertical, 6)
            }
            SourceLabel(source: model.lastSource)
                .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private var answerAndWarnings: some View {
        if !plan.reasoning.warnings.isEmpty {
            DisclosureGroup {
                ForEach(Array(plan.reasoning.warnings.enumerated()), id: \.offset) { pair in
                    Label(pair.element.text, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(PipDesign.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 5)
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
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.footnote.weight(.bold))
                .foregroundStyle(PipDesign.accent)
                .frame(width: 30, height: 30)
                .background(PipDesign.surface, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text("What changed")
                    .pipEyebrow(PipDesign.accent)
                Text(headline)
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(PipDesign.mist, in: RoundedRectangle(cornerRadius: PipDesign.radiusSmall, style: .continuous))
        .accessibilityElement(children: .combine)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center) {
                    eyebrow
                    Spacer(minLength: 8)
                    if let flag = item.flag { FlagPill(flag: flag) }
                }
                VStack(alignment: .leading, spacing: 6) {
                    eyebrow
                    if let flag = item.flag { FlagPill(flag: flag) }
                }
            }

            Text(item.title)
                .font(PipDesign.title)
                .fixedSize(horizontal: false, vertical: true)

            DoNowStakesStrip(item: item, planNow: planNow)

            Text(item.action)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)

            // Due time and money at risk live in DoNowStakesStrip above.
            if let minutes = item.estMinutes {
                PipFlowLayout {
                    PipPill(text: "\(minutes) min", systemImage: "timer")
                }
            }

            Button {
                model.startNow(item: item)
            } label: {
                Label(isStarted ? "Started" : "Start now", systemImage: isStarted ? "checkmark" : "play.fill")
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isStarted)
            .padding(.top, 2)

            if isStarted {
                Label("Saved to History", systemImage: "checkmark.circle.fill")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(PipDesign.positive)
                    .transition(.opacity)
            }

            OverrunPreviewButton(item: item)

            // Reason sits under the action so Start stays above the fold on small iPhones.
            Text(item.why)
                .font(.subheadline)
                .foregroundStyle(PipDesign.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if item.opensDetail {
                NavigationLink {
                    TaskDetailView(item: item, task: model.task(for: item), planNow: planNow)
                } label: {
                    HStack(spacing: 4) {
                        Text("Why this is first")
                        Image(systemName: "chevron.right").imageScale(.small)
                    }
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
            }
        }
        .pipCard(emphasized: true)
        .overlay {
            RoundedRectangle(cornerRadius: PipDesign.radius, style: .continuous)
                .strokeBorder(isHighlighted ? PipDesign.accent : .clear, lineWidth: 2)
        }
    }

    private var eyebrow: some View {
        Label("Do this now", systemImage: "sparkle")
            .labelStyle(PipCompactLabelStyle())
            .pipEyebrow(PipDesign.accent)
    }
}

private struct PlanSectionList: View {
    @Environment(AppModel.self) private var model
    let title: String
    let items: [PlanItem]
    let planNow: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(PipDesign.heading)
                if items.count > 1 {
                    Text("\(items.count)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(PipDesign.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(PipDesign.mist, in: Capsule())
                }
                Spacer()
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            VStack(spacing: 0) {
                ForEach(items) { item in
                    VStack(spacing: 0) {
                        if item.itemId != items.first?.itemId {
                            Divider().padding(.leading, 58)
                        }
                        row(for: item)
                    }
                    .transition(.opacity.combined(with: .move(edge: .leading)))
                }
            }
            .background(PipDesign.surface)
            .clipShape(RoundedRectangle(cornerRadius: PipDesign.radius, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: PipDesign.radius, style: .continuous).strokeBorder(PipDesign.line) }
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
            // Rows without a detail page expand in place; the row itself stays compact.
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.action).font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(item.why).font(.footnote).foregroundStyle(PipDesign.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 58)
                .padding(.bottom, 12)
            } label: {
                PlanRow(item: item, planNow: planNow, highlighted: highlighted, showsChevron: false)
            }
            .padding(.trailing, 14)
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
            TaskGlyph(category: item.category, fixed: item.kind == .fixedBlock, size: 32)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(item.kind == .fixedBlock ? "Fixed class" : "Flexible task")
            VStack(alignment: .leading, spacing: 5) {
                Text(item.kind == .fixedBlock ? "Fixed" : item.category?.label ?? "Task")
                    .pipEyebrow()
                Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(PipDesign.ink)
                    .fixedSize(horizontal: false, vertical: true)
                PipFlowLayout {
                    Text(item.timeLabel(relativeTo: planNow) ?? "Anytime")
                        .font(.footnote.weight(.medium).monospacedDigit()).foregroundStyle(PipDesign.accent)
                        .padding(.vertical, 4)
                    if let flag = item.flag { FlagPill(flag: flag) }
                }
                // Rows without a detail page show action and reason in their disclosure instead.
                if item.opensDetail {
                    Text(item.why).font(.footnote).foregroundStyle(PipDesign.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if item.kind == .fixedBlock {
                        Text(item.action).font(.footnote).foregroundStyle(PipDesign.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if highlighted {
                    Label("Updated", systemImage: "arrow.up.arrow.down")
                        .font(.caption.weight(.semibold)).foregroundStyle(PipDesign.accent)
                }
            }
            Spacer(minLength: 0)
            if showsChevron {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(PipDesign.secondary).padding(.top, 9)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(highlighted ? PipDesign.mist : Color.clear)
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

            HStack(alignment: .center, spacing: 12) {
                TextField("Adjust your plan…", text: $text, axis: .vertical)
                    .lineLimit(1...3)
                    .focused($focused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(Color.pipField)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(PipDesign.fieldLine)
                    }

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
                        .foregroundStyle(PipDesign.accent)
                        .frame(width: 44, height: 44)
                }
                .disabled(trimmed.isEmpty || model.isBusy)
                .opacity(trimmed.isEmpty || model.isBusy ? 0.4 : 1)
                .accessibilityLabel("Send follow-up")
            }
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 10)
        .background(PipDesign.background)
        .overlay(alignment: .top) {
            Rectangle().fill(PipDesign.line).frame(height: 1)
        }
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
            DoNowStakesStrip(item: item, planNow: plan.reasoning.now)
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
            OverrunPreviewButton(item: item)
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
