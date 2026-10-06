import { Queue } from 'bullmq';
import { env } from '../config/env';
const uri = new URL(env.REDIS_URL);
export const queueConnection = {
  host: uri.hostname,
  port: Number(uri.port || 6379),
  username: uri.username || undefined,
  password: decodeURIComponent(uri.password) || undefined,
  db: Number(uri.pathname.slice(1) || 0),
  connectTimeout: 5000,
  ...(uri.protocol === 'rediss:' ? { tls: {} } : {}),
};
const defaults = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800, count: 5000 },
};
export const audioQueue = new Queue('audio', {
  connection: { ...queueConnection, maxRetriesPerRequest: 1, commandTimeout: 5000 },
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: defaults,
});
export const notificationQueue = new Queue('notifications', {
  connection: { ...queueConnection, maxRetriesPerRequest: 1, commandTimeout: 5000 },
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: defaults,
});
export async function closeQueues() {
  await Promise.all([audioQueue.close(), notificationQueue.close()]);
}
