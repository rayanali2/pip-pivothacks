import { Router } from 'express';
import type { UniMateService } from '../service';
import { actionSchema, rerankSchema } from './schemas';
import { asyncRoute, parseInput } from './util';

export function plansRouter(service: UniMateService): Router {
  const router = Router();

  router.post(
    '/plans/rerank',
    asyncRoute(async (req, res) => {
      const body = parseInput(rerankSchema, req.body);
      res.json(await service.rerank({ student_id: body.student_id, plan_id: body.plan_id, context: body.context, preview: body.preview }));
    }),
  );

  router.post(
    '/actions',
    asyncRoute(async (req, res) => {
      const body = parseInput(actionSchema, req.body);
      res.json(await service.recordAction({ student_id: body.student_id, plan_id: body.plan_id, task_id: body.task_id, kind: body.kind }));
    }),
  );

  return router;
}
