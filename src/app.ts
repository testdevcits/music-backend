import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { RedisStore } from 'rate-limit-redis';
import { env } from './config/env';
import { connect, logger, redis } from './infrastructure/connections';
import { authenticate } from './middleware/auth';
import { errorHandler } from './middleware/errors';
import { adminRoutes } from './modules/admin/routes';
import { authRoutes } from './modules/auth/routes';
import { billingRoutes } from './modules/billing/routes';
import { catalogRoutes } from './modules/catalog/routes';
import { libraryRoutes } from './modules/library/routes';
import { playbackRoutes } from './modules/playback/routes';
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use(
  pinoHttp({
    logger,
    genReqId: () => randomUUID(),
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);
app.use((req, res, next) => {
  const startedAt = Date.now();
  const authHeader = req.headers.authorization ? 'present' : 'missing';
  logger.info(
    {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      contentType: req.headers['content-type'],
      authHeader,
      query: Object.keys(req.query || {}).length ? req.query : undefined,
    },
    'API request started',
  );

  const originalEnd = res.end.bind(res);
  res.end = ((...args: any[]) => {
    logger.info(
      {
        requestId: req.id,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        authHeader,
        contentLength: res.getHeader('content-length'),
      },
      'API request completed',
    );
    return originalEnd(...args);
  }) as typeof res.end;

  next();
});
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS.split(',').map((v) => v.trim()), credentials: false }));
app.use(
  '/api/v1/admin/songs/:id/uploads',
  express.raw({ type: ['audio/*', 'image/*'], limit: env.MAX_UPLOAD_BYTES }),
);
app.use('/api/v1/users/me/avatar', express.raw({ type: ['image/*'], limit: '10mb' }));
app.use(express.json({ limit: '128kb' }));
app.get('/', (_req, res) =>
  res.json({
    service: 'music-platform',
    version: '1.0.0',
    api: '/api/v1',
    health: '/health/ready',
  }),
);
app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  try {
    await connect();
    if (mongoose.connection.readyState !== 1) throw Error();
    if (redis) await redis.ping();
    res.json({ status: 'ready', backgroundJobs: redis ? 'enabled' : 'disabled' });
  } catch (err) {
    logger.warn({ err, requestId: req.id }, 'Readiness check failed');
    res.status(503).json({ status: 'unavailable' });
  }
});
const limiter = (prefix: string, limit: number) => {
  const options = {
    windowMs: 60000,
    limit,
    standardHeaders: 'draft-8' as const,
    legacyHeaders: false,
  };
  const rateLimitRedis = redis;
  if (!rateLimitRedis) return rateLimit(options);
  return rateLimit({
    ...options,
    store: new RedisStore({
      prefix: `${env.QUEUE_PREFIX}:${prefix}`,
      sendCommand: async (...args: string[]) =>
        rateLimitRedis.call(args[0], ...args.slice(1)) as any,
    }),
  });
};
app.use('/api/v1', async (_req, _res, next) => {
  try {
    await connect();
    next();
  } catch (err) {
    logger.error({ err }, 'Dependency initialization failed');
    _res.status(503).json({ error: { code: 'DEPENDENCY_UNAVAILABLE' } });
  }
});
app.use('/api/v1', limiter('rl:api:', 120), (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/v1/auth', limiter('rl:auth:', 10), authRoutes);
app.use('/api/v1', authenticate, catalogRoutes, libraryRoutes, playbackRoutes, billingRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
app.use(errorHandler);
// Vercel's native Express preset discovers this file and invokes the app.
export default app;
