import pg from 'pg';
import { execSync } from 'node:child_process';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://attendiq:attendiq@localhost:5432/attendiq_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await c.end();
  execSync('npx tsx src/db/migrate.ts', { env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test', JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0000', QR_TOKEN_SECRET: 'test-qr-secret-test-qr-secret-test-qr-0000' }, stdio: 'inherit' });
}
