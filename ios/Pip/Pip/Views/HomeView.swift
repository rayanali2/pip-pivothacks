import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var inputFocused: Bool
    @State private var typedText = ""
    @State private var submittedText = ""

    private var trimmedTyped: String { typedText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasResult: Bool { model.hasCapture && model.currentPlan?.doNow != nil && !model.needsText && model.pipState != .listening }

    var body: some View {
        ScrollView {
            VStack(spacing: PipDesign.gap) {
                header
                HomeContextStrip()
                hero
                if model.pipState == .thinking {
                    PipStatusView(symbol: "", title: "Finding your next step", detail: "Checking your time, tasks, and deadlines…", loading: true)
                        .pipCard()
                    if !submittedText.isEmpty {
                        Text(submittedText).font(.subheadline).foregroundStyle(PipDesign.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if hasResult, let plan = model.currentPlan, let item = plan.doNow {
                    DoNowCard(item: item, planNow: plan.reasoning.now)
                    Button { model.selectedTab = .today } label: {
                        Label("See the rest of today", systemImage: "arrow.right")
                    }
                    .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                }
                if model.hasCapture && model.pipState != .listening {
                    TranscriptCard(onTypeInstead: { inputFocused = true })
                }
                controls
                if model.isOffline {
                    PipStatusView(symbol: "wifi.slash", title: "Ready with Local fallback", detail: "Pip can still plan your day. Live context checks return when the server is connected.")
                }
            }
            .padding(.horizontal, PipDesign.page)
            .padding(.top, 12)
            .padding(.bottom, 28)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: hasResult)
        }
        .scrollDismissesKeyboard(.interactively)
        .pipScreen()
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: model.textFocusRequest) { _, _ in inputFocused = true }
        .onChange(of: model.pipState) { _, state in
            if state != .thinking { submittedText = "" }
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text("A LITTLE SPACE FOR YOUR DAY")
                    .font(.caption2.weight(.bold)).tracking(1.4)
                    .foregroundStyle(PipDesign.secondary)
                Text("Hey, I’m Pip.").font(PipDesign.title)
            }
            Spacer(minLength: 8)
            Button { model.toggleMute() } label: {
                Image(systemName: model.isMuted ? "speaker.slash" : "speaker.wave.2")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
                    .background(Color.white, in: Circle())
            }
            .accessibilityLabel(model.isMuted ? "Unmute Pip" : "Mute Pip")
        }
    }

    private var hero: some View {
        VStack(spacing: 8) {
            PenguinView(state: model.pipState, size: hasResult || model.needsText ? 80 : 158, ready: hasResult)
            if !hasResult && !model.needsText {
                Text(model.pipState == .listening ? "I’m listening." : "What’s on your mind today?")
                    .font(PipDesign.heading).multilineTextAlignment(.center)
                Text("Tell me what’s piling up. We’ll find one place to start.")
                    .font(.subheadline).foregroundStyle(PipDesign.secondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if model.pipState == .listening && !model.isFollowUpRecording { RecordingStatus() }
            HoldToTalkButton(
                isListening: model.pipState == .listening && !model.isFollowUpRecording,
                diameter: hasResult ? 64 : 78,
                onPress: { model.startRecording() },
                onRelease: { model.stopRecordingAndSend() }
            )
            .disabled(model.pipState == .thinking)
            Text(hasResult ? "Hold to tell Pip more" : "Hold to talk")
                .font(.footnote.weight(.semibold)).foregroundStyle(PipDesign.secondary)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Or type your day…", text: $typedText, axis: .vertical)
                    .lineLimit(1...4).focused($inputFocused).padding(14)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 18))
                    .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(PipDesign.line) }
                Button(action: sendTyped) {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold)).foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .background(PipDesign.accent, in: Circle())
                }
                .disabled(trimmedTyped.isEmpty || model.isBusy)
                .opacity(trimmedTyped.isEmpty || model.isBusy ? 0.4 : 1)
                .accessibilityLabel("Send your day")
            }
            HStack {
                Button("Use demo sentence") { typedText = SampleData.demoSentence; inputFocused = true }
                    .font(.footnote.weight(.medium)).frame(minHeight: 44)
                Spacer()
                SourceLabel(source: model.lastSource)
            }
        }
    }

    private func sendTyped() {
        let text = trimmedTyped
        guard !text.isEmpty else { return }
        submittedText = text
        model.sendText(text)
        typedText = ""
        inputFocused = false
    }
}

private struct TranscriptCard: View {
    @Environment(AppModel.self) private var model
    let onTypeInstead: () -> Void

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 12) {
            if model.needsText {
                PipStatusView(symbol: "mic.slash", title: "Let’s try typing", detail: "Pip couldn’t hear that. Add your day below to make a plan.")
                Button("Type instead", action: onTypeInstead).buttonStyle(PrimaryButtonStyle())
            } else {
                DisclosureGroup {
                    TextField("What you said", text: $model.draft, axis: .vertical)
                        .lineLimit(2...8).font(.body).padding(.vertical, 8)
                    if model.isDraftEdited {
                        Button("Update plan") { model.submitEditedTranscript() }
                            .buttonStyle(PrimaryButtonStyle()).disabled(model.isBusy)
                    }
                } label: {
                    Label("Your words", systemImage: "text.bubble")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(PipDesign.ink)
                }
            }
        }
        .pipCard()
    }
}

#Preview("Home") {
    NavigationStack { HomeView() }.environment(AppModel.preview())
}
