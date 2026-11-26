import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  const pgErr = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = pgErr.code ?? pgErr.cause?.code;
  if (code === '23505') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these details already exists', details: { constraint: pgErr.constraint ?? pgErr.cause?.constraint } } });
  }
  if (code === '23503') {
    return res.status(400).json({ error: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist' } });
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. The error has been logged.' } });
}
