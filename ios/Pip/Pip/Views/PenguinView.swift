import SwiftUI

/// Original vector mascot. Presentation state is derived from the existing voice state.
/// While UniMate talks, the beak moves with each spoken word (`AppModel.speechPulse`).
struct PenguinView: View {
    let state: UniMateState
    var size: CGFloat = 180
    var ready = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Optional so previews and views without the model in the environment still render.
    @Environment(AppModel.self) private var model: AppModel?

    @State private var swing = Swing(state: .idle, up: false)
    @State private var beakOpen = false
    @State private var blinking = false

    var body: some View {
        ZStack {
            Circle()
                .fill(UniMateDesign.mist)
                .frame(width: size * 1.18, height: size * 1.18)
            if state == .listening {
                Circle().stroke(UniMateDesign.accent, lineWidth: size * 0.025)
                    .frame(width: size * 1.18, height: size * 1.18)
                    .scaleEffect(reduceMotion ? 1 : (isUp ? 1.1 : 1))
                    .opacity(isUp ? 0.08 : 0.3)
                Circle().strokeBorder(UniMateDesign.accent.opacity(0.4), style: StrokeStyle(lineWidth: 2, dash: [4, 6]))
                    .frame(width: size * 1.32, height: size * 1.32)
            }
            Ellipse().fill(UniMateDesign.ink.opacity(0.09))
                .frame(width: size * 0.7, height: size * 0.1)
                .scaleEffect(state == .speaking && isUp ? 0.9 : 1)
                .offset(y: size * 0.49)
            PenguinFigure(
                size: size,
                listening: state == .listening,
                ready: ready || state == .speaking,
                speaking: state == .speaking,
                beakOpen: beakOpen && state == .speaking,
                blinking: blinking && state == .idle,
                wave: state == .speaking && isUp ? -16 : 0
            )
            .scaleEffect(x: 1, y: state == .idle && isUp ? 1.018 : 1, anchor: .bottom)
            .rotationEffect(.degrees(tilt))
            .offset(y: state == .speaking && isUp ? -size * 0.025 : 0)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: state)
            if state == .thinking {
                HStack(spacing: 4) {
                    Image(systemName: "ellipsis").font(.headline.bold())
                }
                .foregroundStyle(UniMateDesign.accent).padding(10)
                .background(.white, in: Capsule()).offset(x: size * 0.4, y: -size * 0.4)
            } else if ready && state != .listening {
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.12, weight: .bold)).foregroundStyle(.white)
                    .padding(size * 0.08).background(UniMateDesign.positive, in: Circle())
                    .offset(x: size * 0.46, y: -size * 0.34)
            }
        }
        .frame(width: size * 1.4, height: size * 1.4)
        .accessibilityElement()
        .accessibilityLabel("UniMate the penguin, \(ready && state == .idle ? "your next step is ready" : state.caption)")
        // Each loop lives in a task keyed by what it depends on, so SwiftUI cancels it when the
        // state changes or the view disappears. Nothing repeats past its own state.
        .task(id: MotionKey(state: state, reduceMotion: reduceMotion)) { await runMotion() }
        .task(id: state == .idle) { await runBlinks() }
        .task(id: speechPulse) { await speakWord() }
    }

    private var speechPulse: Int { model?.speechPulse ?? 0 }

    /// The swing only counts for the state that started it, so a half-finished bob or sway never shows in the next state.
    private var isUp: Bool { swing.state == state && swing.up }

    private var tilt: Double {
        switch state {
        case .listening: return -7
        case .thinking: return reduceMotion ? 5 : (isUp ? 8 : 2)
        case .idle, .speaking: return 0
        }
    }

    /// Half a cycle of each state's loop: bob while speaking, breathing while idle, the ring while listening, sway while thinking.
    /// Reduce Motion keeps only the listening ring, which then fades without growing.
    private var motionPeriod: Double? {
        switch state {
        case .listening: return 0.9
        case .speaking: return reduceMotion ? nil : 0.42
        case .idle: return reduceMotion ? nil : 2.4
        case .thinking: return reduceMotion ? nil : 1.6
        }
    }

    private func runMotion() async {
        swing = Swing(state: state, up: false)
        beakOpen = false
        guard let period = motionPeriod else { return }
        let pause = UInt64(period * 1_000_000_000)
        while !Task.isCancelled {
            withAnimation(.easeInOut(duration: period)) { swing.up.toggle() }
            try? await Task.sleep(nanoseconds: pause)
        }
    }

    /// Blinks about every 4 s while idle. Allowed with Reduce Motion, just without easing.
    private func runBlinks() async {
        blinking = false
        guard state == .idle else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64.random(in: 3_500_000_000...4_500_000_000))
            guard !Task.isCancelled else { break }
            withAnimation(reduceMotion ? nil : .easeIn(duration: 0.06)) { blinking = true }
            try? await Task.sleep(nanoseconds: 130_000_000)
            // Runs even when cancelled mid-blink, so the eyes never stay shut.
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.1)) { blinking = false }
        }
    }

    /// Opens the beak for one spoken word and closes it about 0.12 s later.
    private func speakWord() async {
        guard state == .speaking else { return }
        withAnimation(reduceMotion ? nil : .spring(response: 0.12, dampingFraction: 0.55)) { beakOpen = true }
        try? await Task.sleep(nanoseconds: 120_000_000)
        // A newer word replaced this task; it owns the beak now.
        guard !Task.isCancelled else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.1)) { beakOpen = false }
    }

    private struct Swing: Equatable {
        var state: UniMateState
        var up: Bool
    }

    private struct MotionKey: Equatable {
        let state: UniMateState
        let reduceMotion: Bool
    }
}

private struct PenguinFigure: View {
    let size: CGFloat
    let listening: Bool
    let ready: Bool
    let speaking: Bool
    let beakOpen: Bool
    let blinking: Bool
    /// Extra rotation for the raised flipper around its shoulder; negative lifts it.
    let wave: Double
    private let beak = Color(red: 0.85, green: 0.61, blue: 0.39)
    private let lowerBeak = Color(red: 0.76, green: 0.51, blue: 0.32)
    private let mouth = Color(red: 0.42, green: 0.20, blue: 0.22)

    var body: some View {
        ZStack {
            if speaking {
                speechArcs
                    .offset(x: -size * 0.36, y: -size * 0.12)
                    .transition(.opacity)
            }
            HStack(spacing: size * 0.15) {
                Capsule().fill(beak).rotationEffect(.degrees(-12))
                Capsule().fill(beak).rotationEffect(.degrees(12))
            }
            .frame(width: size * 0.55, height: size * 0.1).offset(y: size * 0.44)
            flipper.rotationEffect(.degrees(listening ? 65 : 24))
                .offset(x: -size * 0.35, y: listening ? -size * 0.1 : size * 0.09)
            flipper.rotationEffect(.degrees(wave), anchor: .top)
                .rotationEffect(.degrees(ready ? -65 : -24))
                .offset(x: size * 0.35, y: ready ? -size * 0.1 : size * 0.09)
            Ellipse().fill(UniMateDesign.ink)
                .frame(width: size * 0.78, height: size * 0.91)
                .overlay { Ellipse().strokeBorder(.white, lineWidth: size * 0.025) }
            Ellipse().fill(Color(red: 0.99, green: 0.98, blue: 0.95))
                .frame(width: size * 0.61, height: size * 0.72).offset(y: size * 0.06)
            // A little dark crown makes the white face read as a penguin, even at small sizes.
            Ellipse().fill(UniMateDesign.ink)
                .frame(width: size * 0.13, height: size * 0.12).offset(y: -size * 0.30)
            HStack(spacing: size * 0.19) {
                eye
                eye
            }.offset(y: -size * 0.1)
            HStack(spacing: size * 0.31) {
                blush
                blush
            }.offset(y: size * 0.015)
            // The mouth and lower beak hide behind the upper beak until a spoken word drops them open.
            Ellipse().fill(mouth)
                .frame(width: size * 0.07, height: size * 0.07)
                .scaleEffect(x: 1, y: beakOpen ? 1 : 0.1, anchor: .top)
                .offset(y: size * 0.06)
            Capsule().fill(lowerBeak)
                .frame(width: size * 0.065, height: size * 0.032)
                .offset(y: size * (beakOpen ? 0.1 : 0.03))
            RoundedRectangle(cornerRadius: size * 0.025)
                .fill(beak).frame(width: size * 0.12, height: size * 0.08)
                .rotationEffect(.degrees(45)).offset(y: size * 0.015)
            Capsule().fill(UniMateDesign.accent.opacity(0.75))
                .frame(width: size * 0.38, height: size * 0.065).offset(y: size * 0.20)
            RoundedRectangle(cornerRadius: 3).fill(UniMateDesign.accent)
                .frame(width: size * 0.075, height: size * 0.16)
                .rotationEffect(.degrees(-12)).offset(x: size * 0.12, y: size * 0.25)
        }
        .frame(width: size, height: size)
    }

    private var flipper: some View {
        Ellipse().fill(UniMateDesign.ink).frame(width: size * 0.16, height: size * 0.4)
            .overlay { Ellipse().strokeBorder(.white, lineWidth: size * 0.018) }
    }
    private var eye: some View {
        Capsule().fill(UniMateDesign.ink)
            .frame(width: size * 0.045, height: size * (blinking ? 0.012 : ready ? 0.045 : 0.07))
    }
    private var blush: some View {
        Ellipse().fill(Color(red: 0.90, green: 0.71, blue: 0.66).opacity(0.65))
            .frame(width: size * 0.09, height: size * 0.045)
    }
    /// Three small arcs beside the head that brighten with each word, outer ones a beat later.
    private var speechArcs: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .trim(from: 0.47, to: 0.63)
                    .stroke(UniMateDesign.accent, style: StrokeStyle(lineWidth: size * 0.02, lineCap: .round))
                    .frame(width: size * (0.14 + 0.1 * CGFloat(index)), height: size * (0.14 + 0.1 * CGFloat(index)))
                    .opacity((beakOpen ? 0.8 : 0.25) * (1 - Double(index) * 0.3))
                    .animation(.easeOut(duration: 0.3).delay(Double(index) * 0.05), value: beakOpen)
            }
        }
    }
}

/// Feeds speech pulses at a talking pace so the speaking state moves in previews.
private struct TalkingPenguinPreview: View {
    let model: AppModel

    var body: some View {
        PenguinView(state: .speaking, size: 110)
            .environment(model)
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: UInt64.random(in: 180_000_000...380_000_000))
                    model.speechPulse += 1
                }
            }
    }
}

#Preview("Penguin states") {
    VStack {
        HStack { PenguinView(state: .idle, size: 110); PenguinView(state: .listening, size: 110) }
        HStack { PenguinView(state: .thinking, size: 110); PenguinView(state: .idle, size: 110, ready: true) }
        TalkingPenguinPreview(model: AppModel.preview(withPlan: false))
    }
}
