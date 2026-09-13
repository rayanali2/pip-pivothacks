import { Router } from 'express';
import type { PipService } from '../service';
import { putProfileSchema, putTimetableSchema, studentQuerySchema } from './schemas';
import { asyncRoute, parseInput } from './util';

export function scheduleRouter(service: PipService): Router {
  const router = Router();

  router.get(
    '/timetable/today',
    asyncRoute(async (req, res) => {
      const q = parseInput(studentQuerySchema, req.query);
      res.json(await service.timetableToday(q.student_id));
    }),
  );

  router.get(
    '/timetable',
    asyncRoute(async (req, res) => {
      const q = parseInput(studentQuerySchema, req.query);
      res.json(await service.timetable(q.student_id));
    }),
  );

  router.put(
    '/timetable',
    asyncRoute(async (req, res) => {
      const body = parseInput(putTimetableSchema, req.body);
      res.json(await service.putTimetable({ student_id: body.student_id, blocks: body.blocks }));
    }),
  );

  router.get(
    '/profile',
    asyncRoute(async (req, res) => {
      const q = parseInput(studentQuerySchema, req.query);
      res.json(await service.profile(q.student_id));
    }),
  );

  router.put(
    '/profile',
    asyncRoute(async (req, res) => {
      const body = parseInput(putProfileSchema, req.body);
      res.json(await service.putProfile(body));
    }),
  );

  return router;
}
