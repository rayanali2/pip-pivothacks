import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var inputFocused: Bool
    @State private var typedText = ""
    @State private var submittedText = ""

    private var trimmedTyped: String { typedText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasResult: Bool { model.hasCapture && model.currentPlan?.doNow != nil && !model.needsText && model.uniMateState != .listening && !model.isRevealingUniMateeline }

    var body: some View {
        ScrollView {
            VStack(spacing: UniMateDesign.gap) {
                header
                HomeContextStrip()
                hero
                if model.uniMateState == .thinking || model.isRevealingUniMateeline {
                    // Only a new capture reveals stages; a rerank from Home would show the last capture's.
                    if model.isRevealingUniMateeline {
                        UniMateelineRevealView()
                    } else {
                        UniMateStatusView(symbol: "", title: "Finding your next step", detail: "Checking time, tasks and deadlines", loading: true)
                            .uniMateCard()
                    }
                    if !submittedText.isEmpty {
                        Text("“\(submittedText)”").font(.footnote).foregroundStyle(UniMateDesign.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if hasResult, let plan = model.currentPlan, let item = plan.doNow {
                    DoNowCard(item: item, planNow: plan.reasoning.now)
                    UpNextList(plan: plan)
                }
                if model.hasCapture && model.uniMateState != .listening {
                    TranscriptCard(onTypeInstead: { inputFocused = true })
                }
                controls
                if model.isOffline {
                    UniMateStatusView(symbol: "wifi.slash", title: "Server unavailable", detail: Config.isDemoMode ? "Developer demo data is active." : "Reconnect to create or update your plan. Check the server address in Schedule.")
                }
            }
            .padding(.horizontal, UniMateDesign.page)
            .padding(.top, 8)
            .padding(.bottom, 28)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: hasResult)
        }
        .scrollDismissesKeyboard(.interactively)
        .uniMateScreen()
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: model.textFocusRequest) { _, _ in inputFocused = true }
        .onChange(of: model.uniMateState) { _, state in
            if state != .thinking { submittedText = "" }
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            Text("Hey, I’m UniMate.").font(UniMateDesign.title)
            Spacer(minLength: 8)
            Button { model.toggleMute() } label: {
                Image(systemName: model.isMuted ? "speaker.slash" : "speaker.wave.2")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(UniMateDesign.ink)
                    .frame(width: 44, height: 44)
                    .background(UniMateDesign.surface, in: Circle())
                    .overlay { Circle().strokeBorder(UniMateDesign.line) }
            }
            .accessibilityLabel(model.isMuted ? "Unmute UniMate" : "Mute UniMate")
        }
    }

    private var hero: some View {
        VStack(spacing: 6) {
            PenguinView(state: model.uniMateState, size: hasResult || model.needsText ? 60 : 128, ready: hasResult)
            // Only the idle prompt; while listening the status pill by the mic says it once.
            if !hasResult && !model.needsText && model.uniMateState == .idle {
                Text("What’s on your mind?")
                    .font(UniMateDesign.heading).multilineTextAlignment(.center)
                Text("Say it all. I’ll pick one thing.")
                    .font(.subheadline).foregroundStyle(UniMateDesign.secondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if model.uniMateState == .listening && !model.isFollowUpRecording { RecordingStatus() }
            HoldToTalkButton(
                isListening: model.uniMateState == .listening && !model.isFollowUpRecording,
                diameter: hasResult ? 60 : 84,
                onPress: { model.startRecording() },
                onRelease: { model.stopRecordingAndSend() }
            )
            .disabled(model.uniMateState == .thinking)
            // Room for the halo so it never covers the caption.
            .padding(.vertical, hasResult ? 10 : 16)
            Text(hasResult ? "Hold to tell UniMate more" : "Hold to talk")
                .font(.footnote.weight(.semibold)).foregroundStyle(UniMateDesign.secondary)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Or type your day…", text: $typedText, axis: .vertical)
                    .lineLimit(1...4).focused($inputFocused)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .background(UniMateDesign.surface, in: RoundedRectangle(cornerRadius: UniMateDesign.radius, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: UniMateDesign.radius, style: .continuous).strokeBorder(UniMateDesign.fieldLine) }
                Button(action: sendTyped) {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold)).foregroundStyle(.white)
                        .frame(width: 46, height: 46)
                        .background(UniMateDesign.accent, in: Circle())
                }
                .disabled(trimmedTyped.isEmpty || model.isBusy)
                .opacity(trimmedTyped.isEmpty || model.isBusy ? 0.4 : 1)
                .accessibilityLabel("Send your day")
            }
            .padding(.top, 4)
            ViewThatFits(in: .horizontal) {
                HStack {
                    if Config.isDemoMode { demoButton }
                    Spacer()
                    SourceLabel(source: model.lastSource)
                }
                VStack(alignment: .leading, spacing: 4) {
                    if Config.isDemoMode { demoButton }
                    SourceLabel(source: model.lastSource)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var demoButton: some View {
        Button { typedText = SampleData.demoSentence; inputFocused = true } label: {
            Label("Use demo sentence", systemImage: "text.quote")
                .labelStyle(UniMateCompactLabelStyle())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .font(.footnote.weight(.medium))
    }

    private func sendTyped() {
        let text = trimmedTyped
        guard !text.isEmpty else { return }
        submittedText = text
        model.sendText(text) {
            // Keep an unsent edit or a failed submission available for retry.
            if trimmedTyped == text { typedText = "" }
        }
        inputFocused = false
    }
}

/// A short, read-only glance at what follows the do-now card. The full list lives on Today.
private struct UpNextList: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    let plan: Plan

    private var items: [PlanItem] {
        var seen: Set<String> = [plan.doNow?.itemId ?? ""]
        return Array(([plan.next].compactMap { $0 } + plan.today)
            .filter { seen.insert($0.itemId).inserted }
            .prefix(3))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if !items.isEmpty {
                    Text("Up next").uniMateEyebrow()
                }
                Spacer(minLength: 8)
                Button { model.selectedTab = .today } label: {
                    HStack(spacing: 3) {
                        Text("See all")
                        Image(systemName: "chevron.right").imageScale(.small)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .font(.footnote.weight(.semibold))
                .accessibilityLabel("See the rest of today")
                .accessibilityInputLabels(["See all", "See the rest of today"])
            }
            if !items.isEmpty {
                VStack(spacing: 0) {
                    ForEach(items) { item in
                        if item.itemId != items.first?.itemId { Divider() }
                        row(item)
                    }
                }
                .padding(.horizontal, 14)
                .background(UniMateDesign.surface, in: RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous).strokeBorder(UniMateDesign.line) }
            }
        }
    }

    private func row(_ item: PlanItem) -> some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: 10))
        return layout {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: item.kind == .fixedBlock ? "lock.fill" : "circle.dotted")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(UniMateDesign.accent)
                    .frame(width: stacked ? nil : 18)
                    .accessibilityLabel(item.kind == .fixedBlock ? "Fixed class" : "Flexible task")
                Text(item.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(stacked ? 3 : 1)
            }
            if !stacked { Spacer(minLength: 8) }
            if let time = item.timeLabel(relativeTo: plan.reasoning.now) {
                Text(time)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(UniMateDesign.secondary)
                    .lineLimit(stacked ? nil : 1)
                    .fixedSize(horizontal: !stacked, vertical: stacked)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }
}

private struct TranscriptCard: View {
    @Environment(AppModel.self) private var model
    let onTypeInstead: () -> Void

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            if model.needsText {
                UniMateStatusView(symbol: "mic.slash", title: "Let’s try typing", detail: "UniMate couldn’t hear that.")
                Button("Type instead", action: onTypeInstead).buttonStyle(PrimaryButtonStyle())
            } else {
                DisclosureGroup {
                    TextField("What you said", text: $model.draft, axis: .vertical)
                        .lineLimit(2...8).font(.body)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(UniMateDesign.background, in: RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous))
                        .overlay { RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous).strokeBorder(UniMateDesign.fieldLine) }
                        .padding(.top, 8)
                    if model.isDraftEdited {
                        Button("Update plan") { model.submitEditedTranscript() }
                            .buttonStyle(PrimaryButtonStyle()).disabled(model.isBusy)
                    }
                } label: {
                    Label("Your words", systemImage: "text.bubble")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(UniMateDesign.ink)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                // Offsets the 44pt label so the collapsed card isn't taller than it needs to be.
                .padding(.vertical, -6)
            }
        }
        .uniMateCard()
    }
}

#Preview("Home") {
    NavigationStack { HomeView() }.environment(AppModel.preview())
}
