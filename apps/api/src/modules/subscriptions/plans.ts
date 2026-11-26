import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { subscriptionPlans } from '../../db/schema/index.js';

/** Packaging suggestions for validation, not final pricing. Limits are read from the DB, never hardcoded elsewhere. */
export const DEFAULT_PLANS = [
  { code: 'starter', name: 'Starter', description: 'Attendance management, basic reports and notifications', priceMonthlyInr: null, limits: { maxStudents: 300, maxStaff: 40, maxBranches: 1, aiRequestsPerMonth: 0 }, features: ['attendance.manual', 'reports.basic', 'notifications.in_app'] },
  { code: 'professional', name: 'Professional', description: 'QR attendance, parent portal, advanced reports and AI insights', priceMonthlyInr: null, limits: { maxStudents: 2000, maxStaff: 200, maxBranches: 2, aiRequestsPerMonth: 2000 }, features: ['attendance.manual', 'attendance.qr', 'portal.parent', 'reports.advanced', 'ai.insights', 'notifications.in_app', 'notifications.email'] },
  { code: 'enterprise', name: 'Enterprise', description: 'Multiple campuses, custom integrations and branding', priceMonthlyInr: null, limits: { maxStudents: 50000, maxStaff: 5000, maxBranches: 50, aiRequestsPerMonth: 50000 }, features: ['attendance.manual', 'attendance.qr', 'attendance.rfid', 'portal.parent', 'reports.advanced', 'ai.insights', 'ai.assistant', 'branding.custom', 'integrations.custom', 'notifications.in_app', 'notifications.email', 'notifications.sms', 'notifications.whatsapp'] },
];

export async function ensureSubscriptionPlans(db: DbOrTx) {
  for (const p of DEFAULT_PLANS) {
    await db.insert(subscriptionPlans).values(p).onConflictDoNothing({ target: subscriptionPlans.code });
  }
  void sql;
}
