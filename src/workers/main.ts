import { Worker } from 'bullmq';
import { env } from '../config/env';
import { connect, disconnect, logger } from '../infrastructure/connections';
import { closeQueues, requireQueueConnection } from '../infrastructure/queues';
import { Notification } from '../modules/library/models';
import { processAudio } from './audio';
async function main() {
  await connect();
  const queueConnection = requireQueueConnection();
  const audio = new Worker('audio', processAudio, {
    connection: queueConnection,
    prefix: env.QUEUE_PREFIX,
    concurrency: 1,
  });
  const notifications = new Worker(
    'notifications',
    async (job) => {
      await Notification.updateOne(
        { dedupeKey: job.data.dedupeKey },
        { $setOnInsert: job.data },
        { upsert: true },
      );
    },
    { connection: queueConnection, prefix: env.QUEUE_PREFIX, concurrency: 10 },
  );
  for (const worker of [audio, notifications]) {
    worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Job failed'));
    worker.on('error', (err) => logger.error({ err }, 'Worker error'));
  }
  const stop = async () => {
    await Promise.all([audio.close(), notifications.close()]);
    await closeQueues();
    await disconnect();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  logger.info('Workers ready');
}
main().catch((err) => {
  logger.fatal({ err }, 'Worker startup failed');
  process.exit(1);
});
