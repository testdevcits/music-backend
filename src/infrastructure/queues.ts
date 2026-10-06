import { Queue } from 'bullmq';
import { env } from '../config/env';
import { ApiError } from '../shared/errors';

const defaults = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800, count: 5000 },
};

function getQueueRuntime() {
  const enabled = env.BACKGROUND_JOBS_ENABLED && Boolean(env.REDIS_URL);
  const uri = enabled && env.REDIS_URL ? new URL(env.REDIS_URL) : undefined;
  const connection = uri
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

  return { enabled, connection };
}

export function isQueuesEnabled() {
  return getQueueRuntime().enabled;
}

export const queueConnection = new Proxy({} as Record<string, unknown>, {
  get: (_target, property) => {
    const connection = getQueueRuntime().connection;
    if (!connection) return undefined;
    return connection[property as keyof typeof connection];
  },
  has: (_target, property) => {
    const connection = getQueueRuntime().connection;
    return !!connection && property in connection;
  },
});

const queueCache = new Map<string, Queue>();

function getQueue(name: string) {
  const runtime = getQueueRuntime();
  if (!runtime.enabled || !runtime.connection) {
    const queue = queueCache.get(name);
    if (queue) {
      void queue.close();
      queueCache.delete(name);
    }
    return undefined;
  }

  let queue = queueCache.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: { ...runtime.connection, maxRetriesPerRequest: 1, commandTimeout: 5000 },
      prefix: env.QUEUE_PREFIX,
      defaultJobOptions: defaults,
    });
    queueCache.set(name, queue);
  }
  return queue;
}

export const audioQueue = new Proxy({} as Record<string, unknown>, {
  get: (_target, property) => {
    const queue = getQueue('audio');
    if (!queue) return undefined;
    const value = Reflect.get(queue, property);
    return typeof value === 'function' ? value.bind(queue) : value;
  },
});

export const notificationQueue = new Proxy({} as Record<string, unknown>, {
  get: (_target, property) => {
    const queue = getQueue('notifications');
    if (!queue) return undefined;
    const value = Reflect.get(queue, property);
    return typeof value === 'function' ? value.bind(queue) : value;
  },
});

export function requireAudioQueue() {
  const queue = getQueue('audio');
  if (!queue) throw new ApiError(503, 'AUDIO_PROCESSING_REQUIRES_REDIS');
  return queue;
}

export function requireNotificationQueue() {
  const queue = getQueue('notifications');
  if (!queue) throw new ApiError(503, 'BACKGROUND_JOBS_REQUIRE_REDIS');
  return queue;
}

export function requireQueueConnection() {
  const connection = getQueueRuntime().connection;
  if (!connection) throw Error('REDIS_URL is required to run the background worker');
  return connection;
}

export async function closeQueues() {
  await Promise.all(Array.from(queueCache.values(), (queue) => queue.close()));
  queueCache.clear();
}
