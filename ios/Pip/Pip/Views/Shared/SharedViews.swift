import SwiftUI
import UIKit

extension Color {
    /// Neutral grouped surface used for pills, chips and the transcript card.
    static let pipSurface = Color(uiColor: .secondarySystemBackground)
    static let pipField = Color(uiColor: .tertiarySystemFill)
}

/// "Snowflake" (with snowflake symbol) or "Local fallback".
struct SourceLabel: View {
    let source: Source

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: source == .snowflake ? "snowflake" : "internaldrive")
            Text(source.label)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Source: \(source.label)")
    }
}

/// Capsule showing the free window, e.g. "47 min free until CHEM 110 Lab, 2:00 PM".
struct FreeWindowPill: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "clock")
                .foregroundStyle(Color.accentColor)
            Text(text)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
        .font(.subheadline.weight(.medium))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color.pipSurface))
    }
}

/// "At risk" / "Basic need" pill for plan item flags.
struct FlagPill: View {
    let flag: PlanItemFlag

    private var tint: Color {
        switch flag {
        case .atRisk: return .red
        case .balanceGuard: return Color.accentColor
        case .unknown: return .secondary
        }
    }

    var body: some View {
        Text(flag.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(tint.opacity(0.12)))
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

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.white)
                .frame(maxWidth: fullWidth ? CGFloat.infinity : nil)
                .padding(.vertical, 14)
                .padding(.horizontal, 20)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.accentColor)
                )
                .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.45)
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
        }
    }
}

struct ChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline)
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Capsule().fill(Color.pipSurface))
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

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.accentColor)
            Image(systemName: isListening ? "waveform" : "mic.fill")
                .font(.system(size: diameter * 0.36, weight: .semibold))
                .foregroundStyle(Color.white)
        }
        .frame(width: diameter, height: diameter)
        .scaleEffect(isPressed ? 1.1 : 1)
        .shadow(color: Color.accentColor.opacity(isPressed ? 0.35 : 0.15), radius: isPressed ? 12 : 4, y: 2)
        .animation(.spring(response: 0.3, dampingFraction: 0.6), value: isPressed)
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !isPressed {
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
        .accessibilityLabel(isListening ? "Listening. Release to send." : "Hold to talk")
        .accessibilityAddTraits(.isButton)
    }
}

/// Top banner for errors and short notices.
struct BannerView: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle")
                .foregroundStyle(Color.accentColor)
            Text(text)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.regularMaterial)
        )
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}
