import SwiftUI
import UIKit

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var inputFocused: Bool
    @State private var typedText = ""

    private var trimmedTyped: String {
        typedText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 24) {
                    topRow
                    penguinBlock
                    if model.hasCapture {
                        TranscriptCard(onTypeInstead: { inputFocused = true })
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    TodayStrip(blocks: model.todayTimetable?.blocks ?? [])
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 24)
                .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.hasCapture)
            }
            .scrollDismissesKeyboard(.interactively)

            controls
        }
        .onChange(of: model.textFocusRequest) { _, _ in
            inputFocused = true
        }
    }

    private var topRow: some View {
        HStack(alignment: .center, spacing: 12) {
            if let label = model.todayTimetable?.nextFreeWindow?.label {
                FreeWindowPill(text: label)
            }
            Spacer(minLength: 8)
            SourceLabel(source: model.lastSource)
        }
    }

    private var penguinBlock: some View {
        VStack(spacing: 6) {
            PenguinView(state: model.pipState, size: 170)
            Text(model.pipState.caption)
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var controls: some View {
        VStack(spacing: 14) {
            HoldToTalkButton(
                isListening: model.pipState == .listening && !model.isFollowUpRecording,
                diameter: 84,
                onPress: { model.startRecording() },
                onRelease: { model.stopRecordingAndSend() }
            )

            HStack(alignment: .bottom, spacing: 10) {
                TextField("Or type your day…", text: $typedText, axis: .vertical)
                    .lineLimit(1...4)
                    .focused($inputFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color.pipField)
                    )

                Button {
                    sendTyped()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 34))
                }
                .disabled(trimmedTyped.isEmpty || model.isBusy)
                .accessibilityLabel("Send")
            }

            Button("Use demo sentence") {
                typedText = SampleData.demoSentence
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 12)
        .background(Color(uiColor: .systemBackground))
    }

    private func sendTyped() {
        let text = trimmedTyped
        guard !text.isEmpty else { return }
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
                Label("Pip couldn't hear that", systemImage: "mic.slash")
                    .font(.headline)
                Text("Type your day in the box below and Pip will plan it.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Type instead", action: onTypeInstead)
                    .font(.subheadline.weight(.semibold))
            } else {
                Text("You said")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                TextField("What you said", text: $model.draft, axis: .vertical)
                    .lineLimit(2...8)
                    .font(.body)

                if let title = model.currentPlan?.doNow?.title {
                    Text("Pip says: \(title)")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                        .lineLimit(1)
                }

                HStack(spacing: 12) {
                    Button("See today plan") {
                        model.selectedTab = .today
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(model.currentPlan == nil)

                    if model.isDraftEdited {
                        Button("Update plan") {
                            model.submitEditedTranscript()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .disabled(model.isBusy)
                    }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color.pipSurface)
        )
    }
}

private struct TodayStrip: View {
    let blocks: [TimetableBlock]

    private var sortedBlocks: [TimetableBlock] {
        blocks.sorted { $0.startsAt < $1.startsAt }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Today")
                .font(.headline)
            if blocks.isEmpty {
                Text("No classes today.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(sortedBlocks) { block in
                    HStack(spacing: 10) {
                        Capsule()
                            .fill(Color.accentColor)
                            .frame(width: 3, height: 18)
                        Text(block.summaryLine)
                            .font(.subheadline)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview("Home") {
    HomeView()
        .environment(AppModel.preview())
}
