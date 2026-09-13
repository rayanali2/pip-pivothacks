import SwiftUI

/// A simple vector penguin built from SwiftUI shapes.
/// idle: eyes open; listening: pulsing accent ring; thinking: three dots; speaking: beak flaps.
struct PenguinView: View {
    let state: PipState
    var size: CGFloat = 180

    var body: some View {
        ZStack {
            if state == .listening {
                ListeningRing(size: size)
            }

            if state == .speaking {
                TimelineView(.periodic(from: .now, by: 0.18)) { context in
                    PenguinFigure(size: size, beakOpen: Self.isBeakOpen(at: context.date))
                }
            } else {
                PenguinFigure(size: size, beakOpen: false)
            }

            if state == .thinking {
                ThinkingDots(size: size)
                    .offset(y: -size * 0.62)
            }
        }
        .frame(width: size * 1.35, height: size * 1.35)
        .accessibilityElement()
        .accessibilityLabel("Pip the penguin, \(state.caption)")
    }

    private static func isBeakOpen(at date: Date) -> Bool {
        let frame = Int((date.timeIntervalSinceReferenceDate / 0.18).rounded(.down))
        return frame % 2 == 0
    }
}

private enum PenguinPalette {
    static let navy = Color(red: 0.11, green: 0.15, blue: 0.27)
    static let belly = Color.white
    static let pupil = Color(red: 0.05, green: 0.06, blue: 0.1)
}

private struct PenguinFigure: View {
    let size: CGFloat
    let beakOpen: Bool

    var body: some View {
        ZStack {
            feet
            flippers
            Ellipse()
                .fill(PenguinPalette.navy)
                .frame(width: size * 0.72, height: size * 0.92)
            Ellipse()
                .fill(PenguinPalette.belly)
                .frame(width: size * 0.5, height: size * 0.64)
                .offset(y: size * 0.11)
            eyes
            beak
        }
        .frame(width: size, height: size)
    }

    private var feet: some View {
        HStack(spacing: size * 0.12) {
            Ellipse()
                .fill(Color.accentColor)
                .frame(width: size * 0.2, height: size * 0.08)
            Ellipse()
                .fill(Color.accentColor)
                .frame(width: size * 0.2, height: size * 0.08)
        }
        .offset(y: size * 0.45)
    }

    private var flippers: some View {
        ZStack {
            Ellipse()
                .fill(PenguinPalette.navy)
                .frame(width: size * 0.14, height: size * 0.42)
                .rotationEffect(.degrees(18))
                .offset(x: -size * 0.35, y: size * 0.08)
            Ellipse()
                .fill(PenguinPalette.navy)
                .frame(width: size * 0.14, height: size * 0.42)
                .rotationEffect(.degrees(-18))
                .offset(x: size * 0.35, y: size * 0.08)
        }
    }

    private var eyes: some View {
        HStack(spacing: size * 0.09) {
            eye
            eye
        }
        .offset(y: -size * 0.24)
    }

    private var eye: some View {
        ZStack {
            Circle()
                .fill(Color.white)
                .frame(width: size * 0.12, height: size * 0.12)
            Circle()
                .fill(PenguinPalette.pupil)
                .frame(width: size * 0.06, height: size * 0.06)
                .offset(y: size * 0.01)
        }
    }

    private var beak: some View {
        VStack(spacing: beakOpen ? size * 0.025 : 0) {
            BeakTriangle()
                .fill(Color.accentColor)
                .frame(width: size * 0.15, height: size * 0.07)
            if beakOpen {
                BeakTriangle()
                    .fill(Color.accentColor)
                    .frame(width: size * 0.1, height: size * 0.04)
            }
        }
        .offset(y: beakOpen ? -size * 0.1 : -size * 0.12)
    }
}

/// Downward-pointing triangle.
private struct BeakTriangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct ListeningRing: View {
    let size: CGFloat
    @State private var pulse = false

    var body: some View {
        Circle()
            .stroke(Color.accentColor.opacity(0.45), lineWidth: 6)
            .frame(width: size * 1.12, height: size * 1.12)
            .scaleEffect(pulse ? 1.12 : 0.94)
            .opacity(pulse ? 0.25 : 0.9)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
    }
}

private struct ThinkingDots: View {
    let size: CGFloat

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.3)) { context in
            let active = Int((context.date.timeIntervalSinceReferenceDate / 0.3).rounded(.down)) % 3
            HStack(spacing: size * 0.05) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.accentColor.opacity(index == active ? 1 : 0.3))
                        .frame(width: size * 0.06, height: size * 0.06)
                }
            }
        }
    }
}

#Preview("Penguin states") {
    VStack(spacing: 24) {
        HStack {
            PenguinView(state: .idle, size: 100)
            PenguinView(state: .listening, size: 100)
        }
        HStack {
            PenguinView(state: .thinking, size: 100)
            PenguinView(state: .speaking, size: 100)
        }
    }
    .tint(.orange)
}
