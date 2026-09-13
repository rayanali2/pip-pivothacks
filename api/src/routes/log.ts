import { Router } from 'express';
import type { PipService } from '../service';
import { demoResetSchema, pivotLogCreateSchema, studentQuerySchema } from './schemas';
import { asyncRoute, parseInput } from './util';

/** History, pivot log and demo reset. */
export function logRouter(service: PipService): Router {
  const router = Router();

  router.get(
    '/history',
    asyncRoute(async (req, res) => {
      const q = parseInput(studentQuerySchema, req.query);
      res.json(await service.history(q.student_id));
    }),
  );

  router.get(
    '/pivot-log',
    asyncRoute(async (_req, res) => {
      res.json(await service.pivotLog());
    }),
  );

  router.post(
    '/pivot-log',
    asyncRoute(async (req, res) => {
      const body = parseInput(pivotLogCreateSchema, req.body);
      res.json(await service.createPivotLog(body));
    }),
  );

  router.post(
    '/demo/reset',
    asyncRoute(async (req, res) => {
      const body = parseInput(demoResetSchema, req.body ?? {});
      res.json(await service.resetDemo(body.student_id));
    }),
  );

  return router;
}
