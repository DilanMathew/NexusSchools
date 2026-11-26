import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Section { id: string; name: string; classLevelId: string; academicYearId: string; departmentId: string | null; classTeacherStaffId: string | null; termId: string | null; capacity: number | null }
export interface ClassLevel { id: string; name: string; ordinal: number; programmeId: string | null }
export interface Year { id: string; name: string; startDate: string; endDate: string; isCurrent: boolean }
export interface Dept { id: string; name: string; code: string; headStaffId: string | null }
export interface Subject { id: string; name: string; code: string; kind: string; departmentId: string | null; isElective: boolean; credits: string | null }
export interface StaffLite { id: string; fullName: string; employeeId: string; departmentId: string | null }

const list = <T,>(path: string, enabled = true) => ({ queryKey: ['lookup', path], queryFn: async () => (await api.get<T[]>(path)).data, enabled, staleTime: 60_000 });
export const useYears = (e = true) => useQuery(list<Year>('/academic/years?pageSize=100', e));
export const useLevels = (e = true) => useQuery(list<ClassLevel>('/academic/class-levels?pageSize=500', e));
export const useSections = (e = true) => useQuery(list<Section>('/academic/sections?pageSize=500', e));
export const useDepts = (e = true) => useQuery(list<Dept>('/academic/departments?pageSize=500', e));
export const useSubjects = (e = true) => useQuery(list<Subject>('/academic/subjects?pageSize=500', e));
export const useStaffLite = (e = true) => useQuery(list<StaffLite>('/staff?pageSize=500', e));

/** "Grade 10 A" labels for sections in the current year (or all when no current year). */
export function useSectionOptions(enabled = true) {
  const s = useSections(enabled); const l = useLevels(enabled); const y = useYears(enabled);
  const cur = y.data?.find((x) => x.isCurrent)?.id;
  const opts = (s.data ?? []).filter((x) => !cur || x.academicYearId === cur).map((x) => {
    const lv = l.data?.find((z) => z.id === x.classLevelId);
    return { value: x.id, label: `${lv?.name ?? ''} ${x.name}`.trim(), ordinal: lv?.ordinal ?? 0 };
  }).sort((a, b) => a.ordinal - b.ordinal || a.label.localeCompare(b.label));
  return { options: opts, label: (id?: string | null) => opts.find((o) => o.value === id)?.label ?? '', isLoading: s.isLoading || l.isLoading };
}
