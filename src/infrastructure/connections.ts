import Redis from 'ioredis';
import mongoose from 'mongoose';
import pino from 'pino';
import { env } from '../config/env';
export const logger = pino({
  redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'refreshToken', 'url'],
});
export const redis = env.BACKGROUND_JOBS_ENABLED && env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 5000,
      lazyConnect: true,
    })
  : undefined;
redis?.on('error', (err) => logger.error({ err }, 'Redis error'));
let initialization: Promise<void> | undefined;
mongoose.set('bufferCommands', false);
export async function connect() {
  if (mongoose.connection.readyState === 1 && (!redis || redis.status === 'ready')) return;
  // Fluid compute may send concurrent requests into the same warm instance.
  // Share initialization and reuse pools; never disconnect after each response.
  if (!initialization) {
    initialization = (async () => {
      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(env.MONGO_URI, {
          autoIndex: env.NODE_ENV !== 'production',
          maxPoolSize: env.MONGO_MAX_POOL_SIZE,
          minPoolSize: 0,
          maxIdleTimeMS: 60000,
          serverSelectionTimeoutMS: 5000,
          waitQueueTimeoutMS: 5000,
        });
      }
      if (redis) {
        if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
        else if (redis.status !== 'ready') await redis.ping();
      }
    })().finally(() => {
      initialization = undefined;
    });
  }
  await initialization;
}
export async function disconnect() {
  await mongoose.disconnect();
  if (redis) await redis.quit();
}
