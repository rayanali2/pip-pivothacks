import { Router } from 'express';
import type { PipService } from '../service';
import { asyncRoute, queryString } from './util';

export function healthRouter(service: PipService): Router {
  const router = Router();
  router.get(
    '/health',
    asyncRoute(async (req, res) => {
      const refresh = ['1', 'true', 'yes'].includes((queryString(req, 'refresh') ?? '').toLowerCase());
      res.json(await service.health(refresh));
    }),
  );
  return router;
}
