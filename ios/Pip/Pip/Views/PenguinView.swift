import SwiftUI

/// Original vector mascot. Presentation state is derived from the existing voice state.
struct PenguinView: View {
    let state: PipState
    var size: CGFloat = 180
    var ready = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(PipDesign.mist)
                .frame(width: size * 1.18, height: size * 1.18)
            if state == .listening {
                Circle().strokeBorder(PipDesign.accent.opacity(0.4), style: StrokeStyle(lineWidth: 2, dash: [4, 6]))
                    .frame(width: size * 1.32, height: size * 1.32)
            }
            Ellipse().fill(PipDesign.ink.opacity(0.09))
                .frame(width: size * 0.7, height: size * 0.1).offset(y: size * 0.49)
            PenguinFigure(size: size, listening: state == .listening, ready: ready || state == .speaking)
                .rotationEffect(.degrees(state == .listening ? -7 : state == .thinking ? 5 : 0))
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: state)
            if state == .thinking {
                HStack(spacing: 4) {
                    Image(systemName: "ellipsis").font(.headline.bold())
                }
                .foregroundStyle(PipDesign.accent).padding(10)
                .background(.white, in: Capsule()).offset(x: size * 0.4, y: -size * 0.4)
            } else if ready && state != .listening {
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.12, weight: .bold)).foregroundStyle(.white)
                    .padding(size * 0.08).background(PipDesign.positive, in: Circle())
                    .offset(x: size * 0.46, y: -size * 0.34)
            }
        }
        .frame(width: size * 1.4, height: size * 1.4)
        .accessibilityElement()
        .accessibilityLabel("Pip the penguin, \(ready && state == .idle ? "your next step is ready" : state.caption)")
    }
}

private struct PenguinFigure: View {
    let size: CGFloat
    let listening: Bool
    let ready: Bool
    private let beak = Color(red: 0.85, green: 0.61, blue: 0.39)

    var body: some View {
        ZStack {
            HStack(spacing: size * 0.15) {
                Capsule().fill(beak).rotationEffect(.degrees(-12))
                Capsule().fill(beak).rotationEffect(.degrees(12))
            }
            .frame(width: size * 0.55, height: size * 0.1).offset(y: size * 0.44)
            flipper.rotationEffect(.degrees(listening ? 65 : 24))
                .offset(x: -size * 0.35, y: listening ? -size * 0.1 : size * 0.09)
            flipper.rotationEffect(.degrees(ready ? -65 : -24))
                .offset(x: size * 0.35, y: ready ? -size * 0.1 : size * 0.09)
            Ellipse().fill(PipDesign.ink)
                .frame(width: size * 0.78, height: size * 0.91)
                .overlay { Ellipse().strokeBorder(.white, lineWidth: size * 0.025) }
            Ellipse().fill(Color(red: 0.99, green: 0.98, blue: 0.95))
                .frame(width: size * 0.61, height: size * 0.72).offset(y: size * 0.06)
            // A little dark crown makes the white face read as a penguin, even at small sizes.
            Ellipse().fill(PipDesign.ink)
                .frame(width: size * 0.13, height: size * 0.12).offset(y: -size * 0.30)
            HStack(spacing: size * 0.19) {
                eye
                eye
            }.offset(y: -size * 0.1)
            HStack(spacing: size * 0.31) {
                blush
                blush
            }.offset(y: size * 0.015)
            RoundedRectangle(cornerRadius: size * 0.025)
                .fill(beak).frame(width: size * 0.12, height: size * 0.08)
                .rotationEffect(.degrees(45)).offset(y: size * 0.015)
            Capsule().fill(PipDesign.accent.opacity(0.75))
                .frame(width: size * 0.38, height: size * 0.065).offset(y: size * 0.20)
            RoundedRectangle(cornerRadius: 3).fill(PipDesign.accent)
                .frame(width: size * 0.075, height: size * 0.16)
                .rotationEffect(.degrees(-12)).offset(x: size * 0.12, y: size * 0.25)
        }
        .frame(width: size, height: size)
    }

    private var flipper: some View {
        Ellipse().fill(PipDesign.ink).frame(width: size * 0.16, height: size * 0.4)
            .overlay { Ellipse().strokeBorder(.white, lineWidth: size * 0.018) }
    }
    private var eye: some View {
        Capsule().fill(PipDesign.ink)
            .frame(width: size * 0.045, height: size * (ready ? 0.045 : 0.07))
    }
    private var blush: some View {
        Ellipse().fill(Color(red: 0.90, green: 0.71, blue: 0.66).opacity(0.65))
            .frame(width: size * 0.09, height: size * 0.045)
    }
}

#Preview("Penguin states") {
    VStack {
        HStack { PenguinView(state: .idle, size: 110); PenguinView(state: .listening, size: 110) }
        HStack { PenguinView(state: .thinking, size: 110); PenguinView(state: .idle, size: 110, ready: true) }
    }
}
