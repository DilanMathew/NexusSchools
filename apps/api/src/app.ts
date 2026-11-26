import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { authenticate, tenant } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/routes.js';
import { institutionRouter, createInstitutionForUser } from './modules/institutions/routes.js';
import { usersRouter, rolesRouter } from './modules/users/routes.js';
import { platformRouter } from './modules/platform/routes.js';
import { academicRouter } from './modules/academic/routes.js';
import { studentsRouter } from './modules/students/routes.js';
import { staffRouter } from './modules/staff/routes.js';
import { guardiansRouter } from './modules/students/guardians.js';
import { attendanceRouter } from './modules/attendance/routes.js';
import { timetableRouter } from './modules/timetable/routes.js';
import { analyticsRouter } from './modules/analytics/routes.js';
import { meRouter } from './modules/portal/routes.js';
import { leaveRouter } from './modules/leave/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { announcementsRouter } from './modules/announcements/routes.js';
import { qrPublicRouter } from './modules/attendance/qr.js';
import { reportsRouter } from './modules/reports/routes.js';
import { aiRouter } from './modules/ai/routes.js';
import { pool } from './db/client.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 100_000 : 600, standardHeaders: true, legacyHeaders: false }));

  app.get('/api/health', async (_req, res) => {
    try { await pool.query('select 1'); res.json({ status: 'ok', db: 'ok' }); } catch { res.status(503).json({ status: 'degraded', db: 'unreachable' }); }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/platform', authenticate, platformRouter);
  app.use('/api/institutions', authenticate, createInstitutionForUser);

  // Everything below is tenant-scoped: authenticate → resolve membership → permission checks per route.
  const t = Router();
  t.use(authenticate, tenant);
  t.use('/institution', institutionRouter);
  t.use('/users', usersRouter);
  t.use('/roles', rolesRouter);
  t.use('/academic', academicRouter);
  t.use('/students', studentsRouter);
  t.use('/guardians', guardiansRouter);
  t.use('/staff', staffRouter);
  t.use('/timetable', timetableRouter);
  t.use('/attendance/qr', qrPublicRouter);
  t.use('/attendance', attendanceRouter);
  t.use('/analytics', analyticsRouter);
  t.use('/reports', reportsRouter);
  t.use('/leave', leaveRouter);
  t.use('/notifications', notificationsRouter);
  t.use('/announcements', announcementsRouter);
  t.use('/ai', aiRouter);
  t.use('/me', meRouter);
  app.use('/api/t', t);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
