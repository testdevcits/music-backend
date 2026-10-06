import { app } from './app';
import { env } from './config/env';
import { connect, disconnect, logger } from './infrastructure/connections';
import { closeQueues } from './infrastructure/queues';
async function main() {
  await connect();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API ready'));
  server.requestTimeout = 30000;
  server.headersTimeout = 35000;
  const shutdown = () => {
    const timer = setTimeout(() => process.exit(1), 30000);
    timer.unref();
    server.close(async () => {
      await closeQueues();
      await disconnect();
      clearTimeout(timer);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
main().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
