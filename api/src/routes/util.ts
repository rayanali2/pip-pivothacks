import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { z } from 'zod';
import type { ErrorResponse } from '../types';
import { errorMessage, log } from '../log';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((p) => String(p)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Parses with zod; throws ValidationError (-> 400) on failure. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(formatIssues(result.error));
  return result.data;
}

/** Wraps an async handler so rejections reach the error middleware (never an unhandled 500). */
export function asyncRoute(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

function clientStatus(err: unknown): number | null {
  if (err instanceof ValidationError) return 400;
  if (err instanceof multer.MulterError) return 400;
  if (typeof err === 'object' && err !== null) {
    const status = 'status' in err ? err.status : 'statusCode' in err ? err.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) return 400;
    const type = 'type' in err ? err.type : undefined;
    if (typeof type === 'string' && type.startsWith('entity.')) return 400;
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = clientStatus(err);
  const message = errorMessage(err);
  if (status === null) log.error(`${req.method} ${req.originalUrl} failed: ${message}`);
  else log.info(`${req.method} ${req.originalUrl} rejected: ${message}`);
  const body: ErrorResponse = { source: 'fallback', error: message };
  res.status(status ?? 503).json(body);
};

export const notFound: RequestHandler = (req: Request, res: Response): void => {
  const body: ErrorResponse = { source: 'fallback', error: `not found: ${req.method} ${req.path}` };
  res.status(404).json(body);
};

export function queryString(req: Request, key: string): string | undefined {
  const v = req.query[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}
