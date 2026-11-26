import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { pool } from './db/client.js';

const server = createApp().listen(env.PORT, () => logger.info(`NEXUS AttendIQ API listening on :${env.PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.info(`${sig} received, shutting down`);
    server.close(() => pool.end().finally(() => process.exit(0)));
  });
}
