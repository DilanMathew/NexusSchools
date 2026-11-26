# NEXUS AttendIQ

Intelligent attendance and student monitoring for schools and colleges, built as a multi-tenant SaaS.

See `IMPLEMENTATION_STATUS.md` for what is built and what is left.

## Local development

Needs Node 20+ and PostgreSQL 14+.

```bash
npm install
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL and the secrets
npm run db:migrate
npm run db:seed                              # demo tenants; password Demo@AttendIQ2026
npm run dev:api                              # http://localhost:4000
npm run dev:web                              # http://localhost:5173
npm test                                     # API tests (uses the attendiq_test database)
```

Demo logins: `admin@`, `principal@`, `teacher@`, `student@` and `parent@` at `abc-school.example` or `xyz-college.example`, plus `superadmin@attendiq.example`.
