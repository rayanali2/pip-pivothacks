import { addDays, atTime } from '../clock';
import { firstStepMinutes } from '../ranker/rules';
import type { ContextFixture } from '../ranker/context';

// Pivot 3 demo fixture. Separate from the CONTRACT section 5 baseline (13:13), which is unchanged.
// Only the supplied paths and blocks are used; no travel combinations, prices or durations are derived.

export const PIVOT3_SCENARIO = 'pivot3-lab-headphones';

/** Fixed simulated clock: Monday 2026-09-14, 12:40 PM (America/Toronto). Never the device or server time. */
export function pivot3Now(): Date {
  return new Date(2026, 8, 14, 12, 40, 0, 0);
}

export function pivot3Fixture(): ContextFixture {
  const now = pivot3Now();
  const today = (t: string): Date => atTime(now, t);
  const tomorrow = addDays(now, 1);
  return {
    scenario: PIVOT3_SCENARIO,
    timezone: 'America/Toronto',
    now,
    commitments: [
      { id: 'lab', title: 'CHEM 110 Lab', start: today('14:00'), end: today('16:45'), protected: true, arrival_buffer_minutes: 10 },
      { id: 'groceries', title: 'Groceries run', start: today('17:00'), end: today('17:30'), protected: false, arrival_buffer_minutes: 0 },
      { id: 'meal', title: 'Dinner', start: today('17:30'), end: today('18:00'), protected: true, arrival_buffer_minutes: 0 },
      { id: 'study', title: 'Assignment block', start: today('18:00'), end: today('20:00'), protected: false, arrival_buffer_minutes: 0 },
      { id: 'rest', title: 'Sleep', start: today('22:30'), end: atTime(tomorrow, '07:00'), protected: true, arrival_buffer_minutes: 0 },
    ],
    tasks: [
      {
        id: 'return-headphones',
        title: 'Return headphones for refund',
        deadline: today('17:00'),
        irreversible: true,
        remaining_minutes: null,
        first_step: null,
        prep_step: null,
        refund_at_risk_cents: null,
        paths: [
          {
            id: 'before-lab',
            label: 'Return outing before lab',
            start: { kind: 'now' },
            arrive_for: 'lab',
            segments: [
              { id: 'home-to-shop', label: 'Travel home to shop', minutes: 20 },
              { id: 'processing', label: 'Return processing', minutes: 10 },
              { id: 'shop-to-campus', label: 'Travel shop to campus', minutes: 10 },
            ],
          },
          {
            id: 'after-lab',
            label: 'Return after lab',
            start: { kind: 'after', commitment_id: 'lab' },
            arrive_for: null,
            segments: [
              { id: 'campus-to-shop', label: 'Travel campus to shop', minutes: 20 },
              { id: 'processing', label: 'Return processing', minutes: 10 },
            ],
          },
        ],
      },
      {
        id: 'cs101-assignment',
        title: 'CS 101 assignment',
        deadline: atTime(tomorrow, '18:00'),
        irreversible: false,
        remaining_minutes: 120,
        first_step: { label: 'Start the CS 101 assignment', minutes: firstStepMinutes({ category: 'assignment', est_minutes: 120 }) },
        prep_step: null,
        refund_at_risk_cents: null,
        paths: [
          {
            id: 'evening-block',
            label: 'The 6:00–8:00 PM assignment block',
            start: { kind: 'at', commitment_id: 'study' },
            arrive_for: null,
            segments: [{ id: 'work', label: 'Assignment work (estimate)', minutes: 120 }],
          },
        ],
      },
      {
        id: 'groceries',
        title: 'Groceries',
        deadline: null,
        irreversible: false,
        remaining_minutes: 30,
        first_step: null,
        prep_step: null,
        refund_at_risk_cents: null,
        paths: [
          {
            id: 'confirmed-block',
            label: 'The 5:00–5:30 PM groceries block',
            start: { kind: 'at', commitment_id: 'groceries' },
            arrive_for: null,
            segments: [{ id: 'shop-and-home', label: 'Shopping, travel and arriving home', minutes: 30 }],
          },
        ],
      },
    ],
    money: { currency: 'CAD', cash_cents: 3500, reserve_cents: 1000, planned: [{ id: 'groceries', label: 'Groceries', cents: 1800 }] },
  };
}
