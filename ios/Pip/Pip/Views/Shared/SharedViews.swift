import SwiftUI
import UIKit

extension Color {
    /// Neutral grouped surface used for pills, chips and the transcript card.
    static let uniMateSurface = UniMateDesign.mist
    static let uniMateField = UniMateDesign.surface
}

/// "Snowflake" (with snowflake symbol) or "Local fallback".
struct SourceLabel: View {
    let source: Source

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: source == .snowflake ? "snowflake" : "internaldrive")
                .imageScale(.small)
            Text(source.label)
                .lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(UniMateDesign.surface, in: Capsule())
        .overlay { Capsule().strokeBorder(UniMateDesign.line) }
        .foregroundStyle(UniMateDesign.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Source: \(source.label)")
    }
}

/// Capsule showing the free window, e.g. "47 min free until CHEM 110 Lab, 2:00 PM".
struct FreeWindowPill: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "hourglass")
                .imageScale(.small)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(UniMateDesign.accent)
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous).fill(UniMateDesign.mist))
        .accessibilityElement(children: .combine)
    }
}

/// "At risk" / "Basic need" pill for plan item flags.
struct FlagPill: View {
    let flag: PlanItemFlag

    private var tint: Color {
        switch flag {
        case .atRisk: return UniMateDesign.danger
        case .balanceGuard: return UniMateDesign.positive
        case .unknown: return UniMateDesign.secondary
        }
    }

    private var symbol: String {
        switch flag {
        case .atRisk: return "exclamationmark.triangle.fill"
        case .balanceGuard: return "leaf.fill"
        case .unknown: return "info.circle"
        }
    }

    var body: some View {
        UniMatePill(text: flag.label, systemImage: symbol, tint: tint)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var fullWidth: Bool = true

    func makeBody(configuration: Configuration) -> some View {
        PrimaryButtonBody(configuration: configuration, fullWidth: fullWidth)
    }

    private struct PrimaryButtonBody: View {
        let configuration: ButtonStyleConfiguration
        let fullWidth: Bool
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.dynamicTypeSize) private var typeSize

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.white)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                .multilineTextAlignment(.center)
                .frame(maxWidth: fullWidth ? CGFloat.infinity : nil, minHeight: 24)
                .padding(.vertical, 13)
                .padding(.horizontal, 20)
                .background(
                    RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous)
                        .fill(UniMateDesign.accent)
                )
                .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.5)
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
        }
    }
}

struct ChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote.weight(.medium))
            .lineLimit(1)
            .frame(minHeight: 28)
            .foregroundStyle(UniMateDesign.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Capsule().fill(UniMateDesign.surface))
            .overlay { Capsule().strokeBorder(UniMateDesign.line) }
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// Round mic button: press starts, release stops. Uses DragGesture(minimumDistance: 0).
struct HoldToTalkButton: View {
    let isListening: Bool
    var diameter: CGFloat = 88
    let onPress: () -> Void
    let onRelease: () -> Void

    @State private var isPressed = false
    @State private var pulse = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(UniMateDesign.accent)
            Image(systemName: isListening ? "waveform" : "mic.fill")
                .font(.system(size: diameter * 0.36, weight: .semibold))
                .foregroundStyle(Color.white)
                .symbolEffect(.variableColor.iterative, isActive: isListening && !reduceMotion)
        }
        .frame(width: diameter, height: diameter)
        .background {
            // Soft halo so the mic reads as the main action; it pulses while listening.
            Circle()
                .fill(UniMateDesign.accent.opacity(isListening ? 0.18 : 0.1))
                .padding(-diameter * 0.16)
                .scaleEffect(isListening && pulse && !reduceMotion ? 1.12 : 1)
        }
        .scaleEffect(isPressed ? 1.08 : 1)
        .shadow(color: UniMateDesign.accent.opacity(isPressed ? 0.35 : 0.2), radius: isPressed ? 14 : 8, y: 4)
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.8), value: isPressed)
        .animation(reduceMotion || !isListening ? .default : .easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
        .onChange(of: isListening, initial: true) { _, listening in
            pulse = listening
        }
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if isEnabled && !isPressed {
                        isPressed = true
                        onPress()
                    }
                }
                .onEnded { _ in
                    isPressed = false
                    onRelease()
                }
        )
        .sensoryFeedback(.impact(weight: .medium), trigger: isPressed)
        .accessibilityElement()
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityLabel(isListening ? "Stop recording and send" : "Hold to talk")
        .accessibilityHint("Double tap to start recording. Double tap again to send.")
        .accessibilityAction {
            guard isEnabled else { return }
            if isListening { onRelease() } else { onPress() }
        }
        .accessibilityAddTraits(.isButton)
    }
}

/// Top banner for errors and short notices.
struct BannerView: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(UniMateDesign.accent)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(UniMateDesign.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 10)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(UniMateDesign.secondary)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 14)
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous)
                .fill(UniMateDesign.surface)
        )
        .overlay {
            RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous)
                .strokeBorder(UniMateDesign.line)
        }
        .shadow(color: UniMateDesign.ink.opacity(0.08), radius: 12, y: 4)
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}
