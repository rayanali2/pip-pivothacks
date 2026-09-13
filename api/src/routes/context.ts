import { Router } from 'express';
import { z } from 'zod';
import type { IsoDateTime } from '../types';
import { toIsoLocal } from '../clock';
import { buildContextPlan, type ContextPlan, type OverrunInput } from '../ranker/context';
import { pivot3Fixture } from '../demo/pivot3';
import { asyncRoute, parseInput } from './util';

export interface ContextAction {
  request_id: string;
  plan_request_id: string;
  task_id: string | null;
  kind: 'start_now';
  created_at: IsoDateTime;
}

export interface ContextHistoryEntry {
  request_id: string;
  created_at: IsoDateTime;
  /** carries the input snapshot, do_now, reason, result state and provenance together */
  plan: ContextPlan;
  actions: ContextAction[];
}

/** Accepted context plans with the snapshot each one used. Request ids make repeated delivery a no-op. */
export class ContextStore {
  private entries: ContextHistoryEntry[] = [];
  private revision = 0;

  constructor(private readonly realNow: () => Date = () => new Date()) {}

  plan(requestId: string, statedMinutes: number | null): { plan: ContextPlan; replayed: boolean } {
    const existing = this.entries.find((e) => e.request_id === requestId);
    if (existing) return { plan: structuredClone(existing.plan), replayed: true };
    this.revision += 1;
    const plan = buildContextPlan(pivot3Fixture(), { request_id: requestId, revision: this.revision, stated_minutes: statedMinutes });
    this.entries.push({ request_id: requestId, created_at: toIsoLocal(this.realNow()), plan, actions: [] });
    return { plan: structuredClone(plan), replayed: false };
  }

  /** "What if this takes longer?": same frozen snapshot inputs, one named segment changed. Nothing is stored or mutated. */
  preview(planRequestId: string, overrun: OverrunInput): ContextPlan | null {
    const entry = this.entries.find((e) => e.request_id === planRequestId);
    if (!entry) return null;
    const s = entry.plan.snapshot;
    return buildContextPlan(pivot3Fixture(), { request_id: s.request_id, revision: s.revision, stated_minutes: s.stated_minutes, overrun });
  }

  recordAction(requestId: string, planRequestId: string): { action: ContextAction; replayed: boolean } | null {
    for (const e of this.entries) {
      const done = e.actions.find((a) => a.request_id === requestId);
      if (done) return { action: structuredClone(done), replayed: true };
    }
    const entry = this.entries.find((e) => e.request_id === planRequestId);
    if (!entry) return null;
    const action: ContextAction = {
      request_id: requestId,
      plan_request_id: planRequestId,
      task_id: entry.plan.do_now ? entry.plan.do_now.task_id : null,
      kind: 'start_now',
      created_at: toIsoLocal(this.realNow()),
    };
    entry.actions.push(action);
    return { action: structuredClone(action), replayed: false };
  }

  history(): ContextHistoryEntry[] {
    return structuredClone([...this.entries].reverse());
  }
}

const requestId = z.string().trim().min(8, 'request_id is required').max(128);

const contextPlanSchema = z.object({
  request_id: requestId,
  stated_minutes: z.number().int().min(0).max(1440).nullable().optional(),
});

const contextPreviewSchema = z.object({
  plan_request_id: requestId,
  overrun: z.object({
    task_id: z.string().trim().min(1).max(128),
    path_id: z
      .string()
      .trim()
      .max(128)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    segment_id: z.string().trim().min(1).max(128),
    minutes: z.number().int().min(1).max(240),
  }),
});

const contextActionSchema = z.object({
  request_id: requestId,
  plan_request_id: requestId,
  kind: z.literal('start_now'),
});

export function contextRouter(store: ContextStore): Router {
  const router = Router();

  router.post(
    '/context/plan',
    asyncRoute(async (req, res) => {
      const body = parseInput(contextPlanSchema, req.body);
      const { plan, replayed } = store.plan(body.request_id, body.stated_minutes ?? null);
      res.json({ source: 'fallback', replayed, plan });
    }),
  );

  router.post(
    '/context/preview',
    asyncRoute(async (req, res) => {
      const body = parseInput(contextPreviewSchema, req.body);
      const plan = store.preview(body.plan_request_id, body.overrun);
      if (!plan || !plan.scenario) {
        res.status(400).json({ source: 'fallback', error: 'unknown plan_request_id, task, path or segment' });
        return;
      }
      res.json({ source: 'fallback', plan });
    }),
  );

  router.post(
    '/context/actions',
    asyncRoute(async (req, res) => {
      const body = parseInput(contextActionSchema, req.body);
      const result = store.recordAction(body.request_id, body.plan_request_id);
      if (!result) {
        res.status(400).json({ source: 'fallback', error: `unknown plan_request_id: ${body.plan_request_id}` });
        return;
      }
      res.json({ source: 'fallback', replayed: result.replayed, action: result.action });
    }),
  );

  router.get(
    '/context/history',
    asyncRoute(async (_req, res) => {
      res.json({ source: 'fallback', entries: store.history() });
    }),
  );

  return router;
}
