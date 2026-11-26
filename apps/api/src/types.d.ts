import type { Permission } from './modules/rbac/catalogue.js';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; platformRole: string | null };
      ctx?: TenantContext;
    }
  }
}

export interface TenantContext {
  institutionId: string;
  institutionType: string;
  timezone: string;
  membershipId: string;
  roleKeys: string[];
  permissions: Set<Permission>;
  staffId: string | null;
  staffDepartmentId: string | null;
  studentId: string | null;
  guardianId: string | null;
}
