export interface Membership { institutionId: string; name: string; slug: string; type: string; status: string; logoUrl: string | null; primaryColor: string; isDemo: boolean; roles: { key: string; name: string }[] }
export interface User { id: string; email: string; fullName: string; phone: string | null; platformRole: string | null; preferredLanguage: string }
export interface TenantContext { institutionId: string; institutionType: string; roleKeys: string[]; permissions: string[]; staffId: string | null; studentId: string | null; guardianId: string | null }
export interface Paged<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }
export type AttendanceStatus = 'present' | 'absent' | 'late' | 'half_day' | 'on_leave' | 'excused' | 'medical_leave' | 'on_duty' | 'holiday' | 'not_applicable' | 'pending_verification';

export const STATUS_META: Record<AttendanceStatus, { label: string; short: string; cls: string }> = {
  present: { label: 'Present', short: 'P', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  absent: { label: 'Absent', short: 'A', cls: 'bg-red-100 text-red-800 border-red-200' },
  late: { label: 'Late', short: 'L', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  half_day: { label: 'Half-day', short: 'H', cls: 'bg-orange-100 text-orange-800 border-orange-200' },
  on_leave: { label: 'On leave', short: 'LV', cls: 'bg-sky-100 text-sky-800 border-sky-200' },
  excused: { label: 'Excused', short: 'E', cls: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  medical_leave: { label: 'Medical leave', short: 'ML', cls: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
  on_duty: { label: 'On duty', short: 'OD', cls: 'bg-violet-100 text-violet-800 border-violet-200' },
  holiday: { label: 'Holiday', short: 'HO', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  not_applicable: { label: 'N/A', short: '–', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  pending_verification: { label: 'Pending verification', short: '?', cls: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
};

export const BAND_META: Record<string, { label: string; cls: string }> = {
  eligible: { label: 'Eligible', cls: 'bg-emerald-100 text-emerald-800' },
  warning: { label: 'Warning', cls: 'bg-amber-100 text-amber-800' },
  shortage: { label: 'Shortage', cls: 'bg-red-100 text-red-800' },
  no_data: { label: 'No data', cls: 'bg-slate-100 text-slate-600' },
};
