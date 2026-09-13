import Foundation

/// Stand-in pipeline stages for a response that carried none (bundled offline fixtures, or an
/// older server). Each stage names only an engine the app knows ran, and its numbers come from
/// the response itself.
enum PipelineFallback {
    static let offlineEngine = "Offline fixtures"
    /// A live server that answered without stage details: the app can't say which engine ran.
    static let serverEngine = "Pip server"
    static let typedEngine = "Typed"
    /// Engine of a skipped stage, as the API names it.
    static let notNeededEngine = "Not needed"

    /// - Parameters:
    ///   - transcript: the words behind this plan; nil when no new words came in.
    ///   - typed: the words were typed, so nothing was transcribed.
    ///   - extractedTasks: tasks pulled from these words; nil for follow-ups, which extract none.
    ///   - status: "ok" or "fallback", applied to every stage that ran.
    static func stages(
        transcript: String?,
        typed: Bool,
        extractedTasks: [PipTask]?,
        plan: Plan,
        engine: String,
        status: String
    ) -> [PipelineStage] {
        [
            transcribeStage(transcript: transcript, typed: typed, engine: engine, status: status),
            extractStage(tasks: extractedTasks, engine: engine, status: status),
            rankStage(plan: plan, engine: engine, status: status),
            wordingStage(plan: plan, engine: engine, status: status)
        ]
    }

    // MARK: Private

    private static func transcribeStage(transcript: String?, typed: Bool, engine: String, status: String) -> PipelineStage {
        let words = wordCount(transcript)
        if words == 0 {
            return PipelineStage(
                id: "transcribe", label: "Heard you", engine: notNeededEngine,
                detail: "No new words", status: "skipped", ms: nil, chips: []
            )
        }
        if typed {
            return PipelineStage(
                id: "transcribe", label: "Heard you", engine: typedEngine,
                detail: "\(counted(words, "word")) typed", status: "skipped", ms: nil, chips: []
            )
        }
        return PipelineStage(
            id: "transcribe", label: "Heard you", engine: engine,
            detail: counted(words, "word"), status: status, ms: nil, chips: []
        )
    }

    private static func extractStage(tasks: [PipTask]?, engine: String, status: String) -> PipelineStage {
        guard let tasks else {
            return PipelineStage(
                id: "extract", label: "Pulled out tasks", engine: notNeededEngine,
                detail: "No new tasks · follow-up", status: "skipped", ms: nil, chips: []
            )
        }
        let chips = tasks.map { PipelineChip(kind: "task", label: $0.normalizedText) }
        return PipelineStage(
            id: "extract", label: "Pulled out tasks", engine: engine,
            detail: counted(tasks.count, "task"), status: status, ms: nil, chips: chips
        )
    }

    private static func rankStage(plan: Plan, engine: String, status: String) -> PipelineStage {
        let scored = plan.reasoning.preRank.isEmpty
            ? plan.allItems.filter { $0.kind != .fixedBlock }.count
            : plan.reasoning.preRank.count
        let doNow = plan.doNow.map { "do now: \($0.title)" } ?? "nothing fits right now"
        return PipelineStage(
            id: "rank", label: "Ranked against 5 rules", engine: engine,
            detail: "\(counted(scored, "task")) scored · \(doNow)", status: status, ms: nil, chips: []
        )
    }

    private static func wordingStage(plan: Plan, engine: String, status: String) -> PipelineStage {
        PipelineStage(
            id: "wording", label: "Wrote your plan", engine: engine,
            detail: "\(counted(plan.allItems.count, "item")) + summary",
            status: status, ms: nil, chips: []
        )
    }

    private static func wordCount(_ text: String?) -> Int {
        guard let text else { return 0 }
        return text.split(whereSeparator: { $0.isWhitespace }).count
    }

    private static func counted(_ value: Int, _ noun: String) -> String {
        "\(value) \(value == 1 ? noun : noun + "s")"
    }
}
