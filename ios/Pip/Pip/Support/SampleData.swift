import Foundation

/// In-code sample data for SwiftUI previews (mirrors the contract's demo plan at 13:13).
enum SampleData {
    static let demoSentence = "I have a 2 PM lab. I need to return headphones by 5 PM or lose the refund. My assignment is due tomorrow. I need groceries, and I have $35 until Friday. What should I do?"

    static let plan: Plan? = decode(Plan.self, from: planJSON)
    static let tasks: [PipTask] = decode([PipTask].self, from: tasksJSON) ?? []
    static let todayTimetable: TodayTimetableResponse? = decode(TodayTimetableResponse.self, from: todayJSON)
    /// Stages as the local engines report them (nothing here claims Snowflake or Claude).
    static let pipeline: [PipelineStage] = decode([PipelineStage].self, from: pipelineJSON) ?? []

    /// A focus session on the sample do-now, started just now.
    static var focusSession: FocusSession? {
        guard let item = plan?.doNow else { return nil }
        let now = Date()
        return FocusSession(
            id: "focus-preview",
            item: item,
            title: item.title,
            action: item.action,
            startedAt: now,
            endsAt: now.addingTimeInterval(35 * 60),
            plannedMinutes: 35,
            extendedMinutes: 0,
            nextLabel: "CHEM 110 Lab · 2:00 PM",
            nextLocation: "Science Hall 204",
            moneyAtRisk: item.moneyAtRisk
        )
    }

    static func decode<T: Decodable>(_ type: T.Type, from json: String) -> T? {
        let decoder = PipCoding.makeDecoder()
        return try? decoder.decode(type, from: Data(json.utf8))
    }

    private static let evidenceReturn = """
    [
      {"rule": "irreversible_loss", "label": "Irreversible deadline or money loss", "fired": true, "detail": "Refund of $79 is lost at 5:00 PM (3 h 47 min away)."},
      {"rule": "fixed_block_collision", "label": "Collides with a fixed class/lab block", "fired": true, "detail": "Returns close at 5:00 PM, before CHEM 110 Lab ends at 5:00 PM."},
      {"rule": "basic_needs", "label": "Affects basic needs today", "fired": false, "detail": "Not a meal, rest or medical need."},
      {"rule": "fits_window", "label": "First step fits the free window", "fired": true, "detail": "Needs ~35 min; you have 47 min before CHEM 110 Lab."},
      {"rule": "academic_deadline", "label": "Near academic deadline", "fired": false, "detail": "Not an academic task."}
    ]
    """

    private static let curveReturn = """
    [
      {"hours": 0, "cost": 0.2}, {"hours": 1, "cost": 0.28}, {"hours": 2, "cost": 0.36},
      {"hours": 3, "cost": 0.44}, {"hours": 4, "cost": 1.0}, {"hours": 6, "cost": 1.0},
      {"hours": 8, "cost": 1.0}, {"hours": 12, "cost": 1.0}, {"hours": 18, "cost": 1.0},
      {"hours": 24, "cost": 1.0}, {"hours": 36, "cost": 1.0}, {"hours": 48, "cost": 1.0}
    ]
    """

    private static let planJSON = """
    {
      "plan_id": "plan-preview-1",
      "student_id": "demo",
      "capture_id": "cap-preview-1",
      "created_at": "2026-09-14T13:14:02-07:00",
      "model": "deterministic-ranker-v1",
      "do_now": {
        "item_id": "demo-return-headphones", "kind": "task", "task_id": "demo-return-headphones",
        "title": "Return headphones",
        "action": "Grab the headphones and receipt and head to the store now (~35 min)",
        "category": "errand",
        "why": "The $79 refund is gone at 5:00 PM and you're in CHEM 110 Lab from 2:00 PM, so these 47 min are your last chance.",
        "starts_at": "2026-09-14T13:13:00-07:00", "ends_at": "2026-09-14T13:48:00-07:00",
        "est_minutes": 35, "due_at": "2026-09-14T17:00:00-07:00", "money_at_risk": 79,
        "location": null, "flag": null,
        "rules_fired": ["irreversible_loss", "fixed_block_collision", "fits_window"],
        "evidence": \(evidenceReturn),
        "curve": \(curveReturn),
        "curve_kind": "cliff"
      },
      "next": {
        "item_id": "block:1:14:00", "kind": "fixed_block", "task_id": null,
        "title": "CHEM 110 Lab", "action": "Be at Science Hall 204 by 2:00", "category": "class",
        "why": "You'll have 12 min to spare after the return.",
        "starts_at": "2026-09-14T14:00:00-07:00", "ends_at": "2026-09-14T17:00:00-07:00",
        "est_minutes": 180, "due_at": null, "money_at_risk": null, "location": "Science Hall 204",
        "flag": null, "rules_fired": [], "evidence": [], "curve": [], "curve_kind": null
      },
      "today": [
        {
          "item_id": "demo-assignment", "kind": "task", "task_id": "demo-assignment",
          "title": "Finish CS 101 assignment", "action": "Work through the next section for 90 min",
          "category": "assignment",
          "why": "Due tomorrow at 11:59 PM, so a long session tonight keeps it safe.",
          "starts_at": "2026-09-14T17:15:00-07:00", "ends_at": "2026-09-14T18:45:00-07:00",
          "est_minutes": 180, "due_at": "2026-09-15T23:59:00-07:00", "money_at_risk": null,
          "location": null, "flag": null, "rules_fired": ["fits_window", "academic_deadline"],
          "evidence": [], "curve": [], "curve_kind": "cliff"
        },
        {
          "item_id": "demo-groceries", "kind": "task", "task_id": "demo-groceries",
          "title": "Buy groceries", "action": "Shop with a $21 cap", "category": "errand",
          "why": "Food is a basic need, and $21 leaves $14 until Friday.",
          "starts_at": "2026-09-14T19:00:00-07:00", "ends_at": "2026-09-14T19:40:00-07:00",
          "est_minutes": 40, "due_at": null, "money_at_risk": null, "location": null,
          "flag": null, "rules_fired": ["basic_needs", "fits_window"],
          "evidence": [], "curve": [], "curve_kind": "linear"
        },
        {
          "item_id": "demo-sleep", "kind": "task", "task_id": "demo-sleep",
          "title": "Get a full night's sleep", "action": "Lights out by 11:30 PM", "category": "rest",
          "why": "You've skipped sleep twice; tonight it's protected.",
          "starts_at": "2026-09-14T23:30:00-07:00", "ends_at": null,
          "est_minutes": 480, "due_at": null, "money_at_risk": null, "location": null,
          "flag": "balance_guard", "rules_fired": ["basic_needs"],
          "evidence": [], "curve": [], "curve_kind": "rising_floor"
        }
      ],
      "can_wait": [
        {
          "item_id": "demo-club-rsvp", "kind": "task", "task_id": "demo-club-rsvp",
          "title": "RSVP to Outdoors Club hike", "action": "Send the RSVP", "category": "club",
          "why": "Not due until Friday 5:00 PM and nothing is at risk.",
          "starts_at": null, "ends_at": null, "est_minutes": 5,
          "due_at": "2026-09-18T17:00:00-07:00", "money_at_risk": null, "location": null,
          "flag": null, "rules_fired": ["fits_window"], "evidence": [], "curve": [], "curve_kind": "defer_multiplier"
        },
        {
          "item_id": "demo-laundry", "kind": "task", "task_id": "demo-laundry",
          "title": "Do laundry", "action": "Start a load", "category": "errand",
          "why": "No deadline and no money at risk.",
          "starts_at": null, "ends_at": null, "est_minutes": 90, "due_at": null,
          "money_at_risk": null, "location": null, "flag": null, "rules_fired": [],
          "evidence": [], "curve": [], "curve_kind": "linear"
        }
      ],
      "reasoning": {
        "summary": "Return the headphones now, then head to CHEM 110 Lab.",
        "now": "2026-09-14T13:13:00-07:00",
        "free_window": {
          "starts_at": "2026-09-14T13:13:00-07:00", "ends_at": "2026-09-14T14:00:00-07:00",
          "minutes": 47, "next_block_title": "CHEM 110 Lab",
          "next_block_starts_at": "2026-09-14T14:00:00-07:00",
          "label": "47 min free until CHEM 110 Lab, 2:00 PM"
        },
        "effective_minutes": 47,
        "context": {"available_minutes": null, "cash_available": null, "question": null},
        "cash_available": 35,
        "budget_until": "2026-09-18",
        "days_until_budget": 4,
        "daily_budget": 8.75,
        "warnings": [],
        "balance_guard": ["You've put off sleep twice, so it's on today's plan."],
        "answer": null,
        "pre_rank": [],
        "trigger": "capture",
        "previous_plan_id": null
      }
    }
    """

    private static let tasksJSON = """
    [
      {
        "task_id": "demo-return-headphones", "student_id": "demo", "capture_id": "cap-preview-1",
        "raw_text": "I need to return headphones by 5 PM or lose the refund",
        "normalized_text": "Return headphones for refund", "category": "errand",
        "due_at": "2026-09-14T17:00:00-07:00", "money_at_risk": 79, "est_minutes": 35,
        "status": "open", "defer_count": 0, "created_at": "2026-09-13T17:13:00-07:00"
      }
    ]
    """

    private static let pipelineJSON = """
    [
      {"id": "transcribe", "label": "Heard you", "engine": "On-device speech (iOS)", "detail": "36 words", "status": "ok", "ms": 820, "chips": []},
      {"id": "extract", "label": "Pulled out tasks", "engine": "Heuristic parser", "detail": "3 tasks · 2 constraints", "status": "fallback", "ms": 14, "chips": [
        {"kind": "fixed_block", "label": "Lab 2:00 PM"},
        {"kind": "task", "label": "Return headphones by 5 PM"},
        {"kind": "task", "label": "CS 101 assignment"},
        {"kind": "task", "label": "Buy groceries"},
        {"kind": "cash", "label": "$35 until Friday"},
        {"kind": "question", "label": "What should I do?"}
      ]},
      {"id": "rank", "label": "Ranked against 5 rules", "engine": "Deterministic 5-rule ranker", "detail": "6 tasks scored · do now: Return headphones", "status": "ok", "ms": 6, "chips": []},
      {"id": "wording", "label": "Wrote your plan", "engine": "Templates", "detail": "47 min free · 7 items", "status": "ok", "ms": 2, "chips": []}
    ]
    """

    private static let todayJSON = """
    {
      "source": "fallback",
      "student_id": "demo",
      "now": "2026-09-14T13:13:00-07:00",
      "day_of_week": 1,
      "blocks": [
        {"student_id": "demo", "day_of_week": 1, "title": "CHEM 110 Lecture", "starts_at": "10:00", "ends_at": "11:20", "location": "Science Hall 120"},
        {"student_id": "demo", "day_of_week": 1, "title": "CHEM 110 Lab", "starts_at": "14:00", "ends_at": "17:00", "location": "Science Hall 204"}
      ],
      "free_windows": [],
      "next_free_window": {
        "starts_at": "2026-09-14T13:13:00-07:00", "ends_at": "2026-09-14T14:00:00-07:00",
        "minutes": 47, "next_block_title": "CHEM 110 Lab",
        "next_block_starts_at": "2026-09-14T14:00:00-07:00",
        "label": "47 min free until CHEM 110 Lab, 2:00 PM"
      }
    }
    """
}
