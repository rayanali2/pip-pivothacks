import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { UniMateService } from './service';
import { log } from './log';
import { healthRouter } from './routes/health';
import { capturesRouter } from './routes/captures';
import { plansRouter } from './routes/plans';
import { scheduleRouter } from './routes/timetable';
import { logRouter } from './routes/log';
import { ContextStore, contextRouter } from './routes/context';
import { errorHandler, notFound } from './routes/util';
import { speechRouter } from './routes/speech';

export function createApp(service: UniMateService): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(speechRouter());

  app.use(healthRouter(service));
  app.use(capturesRouter(service));
  app.use(plansRouter(service));
  app.use(scheduleRouter(service));
  app.use(logRouter(service));
  app.use(contextRouter(new ContextStore(() => service.clock.realNow())));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
