# Environment variables (API service)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | yes | — | at least 32 characters; signs access tokens. Generate with `openssl rand -hex 48` |
| `QR_TOKEN_SECRET` | yes | — | at least 32 characters; signs rotating QR tokens and hashes scan IPs |
| `NODE_ENV` | no | `development` | `production` enables secure cookies and refuses placeholder secrets |
| `PORT` | no | `4000` | HTTP port |
| `CORS_ORIGIN` | no | `http://localhost:5173` | public web origin; also used in QR and reset links. Comma-separated for several |
| `ACCESS_TOKEN_TTL_SECONDS` | no | `900` | access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | no | `14` | refresh token lifetime |
| `STATIC_DIR` | no | — | built web app directory to serve (single-service deploy) |
| `SEED_DEMO` | no | — | `true` loads or refreshes the demo tenants on start (demo tenants only) |
| `AI_PROVIDER` | no | `none` | `anthropic` enables the LLM assistant |
| `ANTHROPIC_API_KEY` | no | — | needed when `AI_PROVIDER=anthropic`. Set it as a secret, never commit it |
| `AI_MODEL` | no | `claude-opus-5-5` | assistant model |
| `AI_EFFORT` | no | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `LOG_LEVEL` | no | `info` | pino log level |

Web build variable: `VITE_SHOW_DEMO=true` shows the demo-accounts panel on the login page (demo deployments only).

Tests use `TEST_DATABASE_URL` (default `postgres://attendiq:attendiq@localhost:5432/attendiq_test`). Its schema is **dropped and recreated** on every run.
