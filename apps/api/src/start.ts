/** Production entrypoint: apply migrations, optionally (re)load demo data, then serve. */
import { sql } from 'drizzle-orm';
import { runMigrations } from './db/migrate.js';
import { db } from './db/client.js';
import { logger } from './lib/logger.js';

await runMigrations();
if (process.env.SEED_DEMO === 'true') {
  const { seedDemo, DEMO_SEED_VERSION } = await import('./db/seed/index.js');
  // Only demo tenants (is_demo = true) are ever rebuilt; real institutions are untouched.
  const { rows } = await db.execute<{ v: number | null }>(sql`
    select max((a.metadata->>'seedVersion')::int) as v from audit_logs a join institutions i on i.id = a.institution_id
    where a.action = 'demo.seeded' and i.is_demo = true`);
  const current = rows[0]?.v ?? 0;
  if (current < DEMO_SEED_VERSION) {
    logger.info(`Loading demo data v${DEMO_SEED_VERSION} (found v${current})…`);
    await seedDemo();
  }
}
await import('./index.js');
