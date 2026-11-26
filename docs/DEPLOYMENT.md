# Deployment

## Railway (current demo deployment)

- **Project:** `nexus-attendiq`
- **Services:** `Postgres` (Railway template) and `attendiq-app`
- **Build:** `attendiq-app` builds from the root `Dockerfile` (`railway.json`) and deploys on every push to the connected branch.
- **Health check:** `GET /api/health`
- **Start command:** `node dist/start.js`. It applies migrations, refreshes demo data if `SEED_DEMO=true` and the demo version changed, then starts the server.
- **Variables:** `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `JWT_ACCESS_SECRET`, `QR_TOKEN_SECRET`, `CORS_ORIGIN=https://<domain>`, `NODE_ENV=production`, `PORT=4000`, and `SEED_DEMO` / `VITE_SHOW_DEMO` for demo only.

For a real customer deployment, use a separate Railway environment or project with `SEED_DEMO` and `VITE_SHOW_DEMO` unset, and new secrets.

## Any Docker host

```bash
docker build -t attendiq .
```

```bash
docker run -p 4000:4000 -e DATABASE_URL=... -e JWT_ACCESS_SECRET=... -e QR_TOKEN_SECRET=... -e CORS_ORIGIN=https://your.domain attendiq
```

## Database migrations

Migrations run automatically at start. To run them manually:

```bash
npm run db:migrate
```

New migration after a schema change:

```bash
npm run db:generate -w apps/api
```

Commit the generated SQL in `apps/api/drizzle/`.

## Backups and restore

Railway Postgres: enable backups on the Postgres service (Backups tab). Also take your own logical dumps.

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > attendiq-$(date +%F).dump
```

Restore into an empty database:

```bash
pg_restore --no-owner --dbname "$RESTORE_DATABASE_URL" attendiq-YYYY-MM-DD.dump
```

Test a restore regularly. Store dumps encrypted, because they contain children's personal data. Per-institution JSON export is available in Settings → Institution.

## Monitoring

- Structured JSON logs (pino) go to stdout and Railway logs. Authorisation headers and cookies are redacted.
- `/api/health` checks the database.
- The platform console shows API and database health, database size, uptime and AI usage.
- Device health (online, stale, offline) appears in Settings → Devices.
