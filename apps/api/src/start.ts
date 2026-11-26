/** Production entrypoint: apply migrations, optionally load demo data once, then serve. */
import { sql } from 'drizzle-orm';
import { runMigrations } from './db/migrate.js';
import { db } from './db/client.js';
import { logger } from './lib/logger.js';

await runMigrations();
if (process.env.SEED_DEMO === 'true') {
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from institutions where is_demo = true`);
  if (rows[0].n === 0) {
    logger.info('Loading demo data (first start)…');
    const { seedDemo } = await import('./db/seed/index.js');
    await seedDemo();
  }
}
await import('./index.js');
