import { Queue } from 'bullmq';
import { env } from '../config/env';
import { ApiError } from '../shared/errors';

export const queuesEnabled = Boolean(env.REDIS_URL);
const uri = env.REDIS_URL ? new URL(env.REDIS_URL) : undefined;
export const queueConnection = uri
  ? {
      host: uri.hostname,
      port: Number(uri.port || 6379),
      username: uri.username || undefined,
      password: decodeURIComponent(uri.password) || undefined,
      db: Number(uri.pathname.slice(1) || 0),
      connectTimeout: 5000,
      ...(uri.protocol === 'rediss:' ? { tls: {} } : {}),
    }
  : undefined;
const defaults = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800, count: 5000 },
};
function createQueue(name: string) {
  if (!queueConnection) return undefined;
  return new Queue(name, {
    connection: { ...queueConnection, maxRetriesPerRequest: 1, commandTimeout: 5000 },
    prefix: env.QUEUE_PREFIX,
    defaultJobOptions: defaults,
  });
}

export const audioQueue = createQueue('audio');
export const notificationQueue = createQueue('notifications');

export function requireAudioQueue() {
  if (!audioQueue) throw new ApiError(503, 'AUDIO_PROCESSING_REQUIRES_REDIS');
  return audioQueue;
}

export function requireNotificationQueue() {
  if (!notificationQueue) throw new ApiError(503, 'BACKGROUND_JOBS_REQUIRE_REDIS');
  return notificationQueue;
}

export function requireQueueConnection() {
  if (!queueConnection) throw Error('REDIS_URL is required to run the background worker');
  return queueConnection;
}

export async function closeQueues() {
  await Promise.all([audioQueue?.close(), notificationQueue?.close()]);
}
