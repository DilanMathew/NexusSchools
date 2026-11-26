import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db, pool } from './client.js';
import { syncPermissionCatalogue, syncSystemRolePermissions } from '../modules/rbac/catalogue.js';
import { ensureSubscriptionPlans } from '../modules/subscriptions/plans.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  await migrate(db, { migrationsFolder: path.resolve(here, '../../drizzle') });
  await syncPermissionCatalogue(db);
  await syncSystemRolePermissions(db);
  await ensureSubscriptionPlans(db);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => { console.log('Migrations applied.'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
