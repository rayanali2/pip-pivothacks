import type { PivotLogEntry, Profile, Student, Task, TimetableBlock } from '../types';
import { addDays, addHours, atTime, dateOnly, isoDow, nextFridayAfter, toIsoLocal } from '../clock';

export const DEMO_STUDENT_ID = 'demo';
export const DEMO_SEED_CAPTURE_ID = 'demo-capture-seed';

export const DEMO_TRANSCRIPT =
  'I have a 2 PM lab. I need to return headphones by 5 PM or lose the refund. My assignment is due tomorrow. I need groceries, and I have $35 until Friday. What should I do?';

export const DEMO_FOLLOWUP_TRANSCRIPT = 'I only have 25 minutes.';

export const DEMO_TASK_IDS = {
  return: 'demo-return-headphones',
  assignment: 'demo-assignment',
  groceries: 'demo-groceries',
  sleep: 'demo-sleep',
  laundry: 'demo-laundry',
  club: 'demo-club-rsvp',
} as const;

export const DEMO_PIVOT_SEEDS: ReadonlyArray<Omit<PivotLogEntry, 'created_at'>> = [
  {
    entry_id: 'pivot-1',
    pivot_number: 1,
    revealed: 'Problem 7 — Prioritization',
    assumption_changed: 'Generic user',
    response: 'Voice-first ranker with decay curves, with Snowflake as the brain',
    cut: 'None',
    sentence:
      'Problem 7 is prioritization, so UniMate turns a spoken, overloaded day into one ranked next action with Snowflake Cortex as the brain.',
  },
  {
    entry_id: 'pivot-2',
    pivot_number: 2,
    revealed: 'User is a first-time independent university student',
    assumption_changed: 'Generic urgency → practical cost of delay against classes, money, and basic needs',
    response: 'Timetable, budget window, free-window math, basic-needs guard; Today Plan replaces the score',
    cut: 'Generic corpus comparison',
    sentence:
      'We learned our user is a first-time independent student, so UniMate now plans around classes, money, and practical life errands — not generic task urgency.',
  },
];

export interface DemoBaseline {
  student: Student;
  timetable: TimetableBlock[];
  profile: Profile;
  tasks: Task[];
  pivot_log: PivotLogEntry[];
}

/** CONTRACT section 5. `now` is the scenario clock (N); D is its date. Pure. */
export function demoBaseline(now: Date, studentId: string = DEMO_STUDENT_ID): DemoBaseline {
  const D = now;
  const iso = toIsoLocal;
  const block = (day_of_week: number, title: string, starts_at: string, ends_at: string, location: string): TimetableBlock => ({
    student_id: studentId,
    day_of_week,
    title,
    starts_at,
    ends_at,
    location,
  });

  const timetable: TimetableBlock[] = [
    block(1, 'CHEM 110 Lecture', '10:00', '11:20', 'Science Hall 120'),
    block(2, 'MATH 151 Calculus', '09:30', '10:50', 'Math Building 210'),
    block(3, 'CHEM 110 Lecture', '10:00', '11:20', 'Science Hall 120'),
    block(4, 'MATH 151 Calculus', '09:30', '10:50', 'Math Building 210'),
    block(5, 'CS 101 Tutorial', '11:30', '12:20', 'Tech Hub 3'),
    block(isoDow(D), 'CHEM 110 Lab', '14:00', '17:00', 'Science Hall 204'),
  ];

  const friday = nextFridayAfter(D);
  const profile: Profile = {
    student_id: studentId,
    chronotype: 'night_owl',
    cooks_own_meals: true,
    cash_available: 35,
    budget_until: dateOnly(friday),
    procrastinates_on: 'assignment',
    updated_at: iso(addHours(now, -72)),
  };

  const task = (
    task_id: string,
    raw_text: string,
    normalized_text: string,
    category: Task['category'],
    due: Date | null,
    money_at_risk: number | null,
    est_minutes: number,
    defer_count: number,
    hoursAgo: number,
  ): Task => ({
    task_id,
    student_id: studentId,
    capture_id: DEMO_SEED_CAPTURE_ID,
    raw_text,
    normalized_text,
    category,
    due_at: due ? iso(due) : null,
    money_at_risk,
    est_minutes,
    status: 'open',
    defer_count,
    created_at: iso(addHours(now, -hoursAgo)),
  });

  const tasks: Task[] = [
    task(
      DEMO_TASK_IDS.return,
      'I need to return headphones by 5 PM or lose the refund',
      'Return headphones for refund',
      'errand',
      atTime(D, '17:00'),
      79,
      35,
      0,
      20,
    ),
    task(DEMO_TASK_IDS.assignment, 'My assignment is due tomorrow', 'Finish CS 101 assignment', 'assignment', atTime(addDays(D, 1), '23:59'), null, 180, 1, 72),
    task(DEMO_TASK_IDS.groceries, 'I need groceries', 'Buy groceries within budget', 'errand', null, null, 40, 1, 30),
    task(DEMO_TASK_IDS.sleep, 'I keep skipping sleep', "Get a full night's sleep", 'rest', null, null, 480, 2, 40),
    task(DEMO_TASK_IDS.laundry, 'Do laundry', 'Do laundry', 'errand', null, null, 90, 0, 24),
    task(
      DEMO_TASK_IDS.club,
      'RSVP to the Outdoors Club hike',
      'RSVP to Outdoors Club hike',
      'club',
      atTime(friday, '17:00'),
      null,
      5,
      1,
      48,
    ),
  ];

  const pivot_log: PivotLogEntry[] = DEMO_PIVOT_SEEDS.map((p, i) => ({ ...p, created_at: iso(addHours(now, -(48 - i * 24))) }));

  return {
    student: { student_id: studentId, created_at: iso(addDays(now, -7)) },
    timetable,
    profile,
    tasks,
    pivot_log,
  };
}
