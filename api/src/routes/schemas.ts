import { z } from 'zod';
import { ACTION_KINDS, CATEGORIES, CHRONOTYPES } from '../types';

const studentId = z.string().trim().min(1, 'student_id is required').max(128);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const optionalId = z
  .string()
  .trim()
  .max(128)
  .nullable()
  .optional()
  .transform((v) => (v === undefined || v === null || v === '' ? null : v));

export const studentQuerySchema = z.object({
  student_id: studentId,
});

export const captureTextSchema = z.object({
  student_id: studentId,
  text: z.string().trim().min(1, 'text is required').max(5000),
  followup_plan_id: optionalId,
});

export const captureVoiceFieldsSchema = z.object({
  student_id: studentId,
  followup_plan_id: optionalId,
  /** iOS on-device speech result; blank counts as absent */
  client_transcript: z
    .string()
    .max(5000)
    .nullable()
    .optional()
    .transform((v) => (v === undefined || v === null || v.trim() === '' ? null : v.trim())),
});

export const rerankSchema = z.object({
  student_id: studentId,
  plan_id: z.string().trim().min(1, 'plan_id is required').max(128),
  context: z
    .object({
      available_minutes: z.number().int().min(0).max(1440).nullable().optional(),
      cash_available: z.number().min(0).max(1_000_000).nullable().optional(),
      question: z.string().max(2000).nullable().optional(),
    })
    .optional()
    .transform((c) => {
      const out: { available_minutes?: number; cash_available?: number; question?: string } = {};
      if (c?.available_minutes !== undefined && c.available_minutes !== null) out.available_minutes = c.available_minutes;
      if (c?.cash_available !== undefined && c.cash_available !== null) out.cash_available = c.cash_available;
      if (c?.question !== undefined && c.question !== null && c.question.trim() !== '') out.question = c.question.trim();
      return out;
    }),
  /** true: compute plan + diff, persist nothing */
  preview: z
    .boolean()
    .nullable()
    .optional()
    .transform((v) => v === true),
});

const blockSchema = z
  .object({
    day_of_week: z.number().int().min(1).max(7),
    title: z.string().trim().min(1).max(200),
    starts_at: timeOfDay,
    ends_at: timeOfDay,
    location: z.string().max(200).nullable().optional(),
  })
  .refine((b) => b.ends_at > b.starts_at, { message: 'ends_at must be after starts_at' })
  .transform((b) => ({ ...b, location: b.location ?? null }));

export const putTimetableSchema = z.object({
  student_id: studentId,
  blocks: z.array(blockSchema).max(200),
});

export const putProfileSchema = z.object({
  student_id: studentId,
  chronotype: z.enum(CHRONOTYPES).optional(),
  cooks_own_meals: z.boolean().optional(),
  cash_available: z.number().min(0).max(1_000_000).optional(),
  budget_until: isoDate.nullable().optional(),
  procrastinates_on: z.enum(CATEGORIES).nullable().optional(),
});

export const actionSchema = z.object({
  student_id: studentId,
  plan_id: z.string().trim().min(1, 'plan_id is required').max(128),
  task_id: optionalId,
  kind: z.enum(ACTION_KINDS),
});

export const pivotLogCreateSchema = z.object({
  pivot_number: z.number().int().min(1).max(1000),
  revealed: z.string().trim().min(1).max(2000),
  assumption_changed: z.string().trim().min(1).max(2000),
  response: z.string().trim().min(1).max(2000),
  cut: z.string().trim().max(2000),
  sentence: z.string().max(2000).nullable().optional(),
});

export const demoResetSchema = z.object({
  student_id: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'demo' : v)),
});
