import SwiftUI

/// "What if this takes 10 min longer?" on the do-now card: previews the current plan with 10 fewer
/// free minutes. View-only; the plan, History and speech stay untouched.
struct OverrunPreviewButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let item: PlanItem

    /// A task in the current plan with free time left. Previews need the UniMate server, so hidden offline.
    private var isAvailable: Bool {
        guard item.kind == .task, !model.isOffline, let plan = model.currentPlan else { return false }
        return plan.reasoning.effectiveMinutes > 0 && plan.allItems.contains { $0.itemId == item.itemId }
    }

    private var preview: OverrunPreview? {
        guard let preview = model.overrunPreview, preview.itemId == item.itemId else { return nil }
        return preview
    }

    var body: some View {
        if isAvailable {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    model.previewPlanOverrun(item: item)
                } label: {
                    HStack(spacing: 8) {
                        if model.isOverrunPreviewLoading {
                            ProgressView()
                                .controlSize(.small)
                                .tint(UniMateDesign.accent)
                        }
                        Text("What if this takes 10 min longer?")
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(UniMateDesign.accent)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.isOverrunPreviewLoading || model.isBusy)
                .accessibilityLabel(model.isOverrunPreviewLoading ? "Checking 10 extra minutes" : "What if this takes 10 minutes longer?")
                .accessibilityHint("Checks \(item.title) with 10 extra minutes without changing your plan")

                if let preview {
                    OverrunPreviewResultCard(preview: preview)
                        .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: preview)
            .transaction { transaction in
                if reduceMotion { transaction.animation = nil }
            }
        }
    }
}

private struct OverrunPreviewResultCard: View {
    let preview: OverrunPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "clock.badge.exclamationmark")
                    .foregroundStyle(UniMateDesign.accent)
                Text(preview.headline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.subheadline.weight(.semibold))
            if preview.changed {
                Text("Do now would be: \(preview.doNowTitle ?? "nothing fits")")
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Preview only · your plan is unchanged")
                .font(.caption)
                .foregroundStyle(UniMateDesign.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UniMateDesign.surface, in: RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: UniMateDesign.radiusSmall, style: .continuous).strokeBorder(UniMateDesign.accent.opacity(0.3)) }
        .accessibilityElement(children: .combine)
    }
}

#Preview("Overrun preview") {
    OverrunPreviewButtonPreview()
        .environment(OverrunPreviewButtonPreview.model())
}

private struct OverrunPreviewButtonPreview: View {
    /// Online, with an answer already showing for the sample do-now.
    @MainActor static func model() -> AppModel {
        let model = AppModel.preview()
        model.isOffline = false
        if let item = SampleData.plan?.doNow {
            model.overrunPreview = OverrunPreview(
                itemId: item.itemId,
                headline: "With 37 minutes, Return headphones still comes first.",
                doNowTitle: item.title,
                changed: false
            )
        }
        return model
    }

    var body: some View {
        if let plan = SampleData.plan, let item = plan.doNow {
            VStack(alignment: .leading, spacing: 12) {
                Text(item.title)
                    .font(UniMateDesign.heading)
                DoNowStakesStrip(item: item, planNow: plan.reasoning.now)
                OverrunPreviewButton(item: item)
            }
            .uniMateCard(emphasized: true)
            .padding(UniMateDesign.page)
            .frame(maxHeight: .infinity, alignment: .top)
            .uniMateScreen()
        } else {
            Text("No sample plan")
        }
    }
}
