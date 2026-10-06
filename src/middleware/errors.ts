import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../infrastructure/connections';
import { ApiError } from '../shared/errors';
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: err.flatten() } });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err.code === 11000) {
    res.status(409).json({ error: { code: 'ALREADY_EXISTS' } });
    return;
  }
  if (
    err.name === 'CastError' ||
    err.name === 'ValidationError' ||
    err.type === 'entity.parse.failed'
  ) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST' } });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    return;
  }
  logger.error({ err, requestId: req.id }, 'Request failed');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
};
