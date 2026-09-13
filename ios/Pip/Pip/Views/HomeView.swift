import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var inputFocused: Bool
    @State private var typedText = ""
    @State private var submittedText = ""

    private var trimmedTyped: String { typedText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasResult: Bool { model.hasCapture && model.currentPlan?.doNow != nil && !model.needsText && model.uniMateState != .listening }

    var body: some View {
        ScrollView {
            VStack(spacing: UniMateDesign.gap) {
                header
                HomeContextStrip()
                hero
                if model.uniMateState == .thinking {
                    UniMateStatusView(symbol: "", title: "Finding your next step", detail: "Checking your time, tasks, and deadlines…", loading: true)
                        .uniMateCard()
                    if !submittedText.isEmpty {
                        Text(submittedText).font(.subheadline).foregroundStyle(UniMateDesign.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if hasResult, let plan = model.currentPlan, let item = plan.doNow {
                    DoNowCard(item: item, planNow: plan.reasoning.now)
                    Button { model.selectedTab = .today } label: {
                        Label("See the rest of today", systemImage: "arrow.right")
                    }
                    .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                }
                if model.hasCapture && model.uniMateState != .listening {
                    TranscriptCard(onTypeInstead: { inputFocused = true })
                }
                controls
                if model.isOffline {
                    UniMateStatusView(symbol: "wifi.slash", title: "Ready with Local fallback", detail: "UniMate can still plan your day. Live context checks return when the server is connected.")
                }
            }
            .padding(.horizontal, UniMateDesign.page)
            .padding(.top, 12)
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
            VStack(alignment: .leading, spacing: 4) {
                Text("A LITTLE SPACE FOR YOUR DAY")
                    .font(.caption2.weight(.bold)).tracking(1.4)
                    .foregroundStyle(UniMateDesign.secondary)
                Text("Hey, I’m UniMate.").font(UniMateDesign.title)
            }
            Spacer(minLength: 8)
            Button { model.toggleMute() } label: {
                Image(systemName: model.isMuted ? "speaker.slash" : "speaker.wave.2")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 44, height: 44)
                    .background(Color.white, in: Circle())
            }
            .accessibilityLabel(model.isMuted ? "Unmute UniMate" : "Mute UniMate")
        }
    }

    private var hero: some View {
        VStack(spacing: 8) {
            PenguinView(state: model.uniMateState, size: hasResult || model.needsText ? 80 : 158, ready: hasResult)
            if !hasResult && !model.needsText {
                Text(model.uniMateState == .listening ? "I’m listening." : "What’s on your mind today?")
                    .font(UniMateDesign.heading).multilineTextAlignment(.center)
                Text("Tell me what’s piling up. We’ll find one place to start.")
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
                diameter: hasResult ? 64 : 78,
                onPress: { model.startRecording() },
                onRelease: { model.stopRecordingAndSend() }
            )
            .disabled(model.uniMateState == .thinking)
            Text(hasResult ? "Hold to tell UniMate more" : "Hold to talk")
                .font(.footnote.weight(.semibold)).foregroundStyle(UniMateDesign.secondary)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Or type your day…", text: $typedText, axis: .vertical)
                    .lineLimit(1...4).focused($inputFocused).padding(14)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 18))
                    .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(UniMateDesign.line) }
                Button(action: sendTyped) {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold)).foregroundStyle(.white)
                        .frame(width: 48, height: 48)
                        .background(UniMateDesign.accent, in: Circle())
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
                UniMateStatusView(symbol: "mic.slash", title: "Let’s try typing", detail: "UniMate couldn’t hear that. Add your day below to make a plan.")
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
                        .font(.subheadline.weight(.semibold)).foregroundStyle(UniMateDesign.ink)
                }
            }
        }
        .uniMateCard()
    }
}

#Preview("Home") {
    NavigationStack { HomeView() }.environment(AppModel.preview())
}
