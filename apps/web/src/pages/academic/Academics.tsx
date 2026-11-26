import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Confirm, Empty, PageHeader, QueryState, Tabs, useToast } from '../../components/ui';
import { FormModal, type FieldDef } from '../../components/FormModal';
import { useDepts, useLevels, useSectionOptions, useStaffLite, useSubjects, useYears } from '../../lib/lookups';
import { fmtDate, fmtTime, titleCase } from '../../lib/format';

type Tab = 'years' | 'terms' | 'departments' | 'programmes' | 'levels' | 'sections' | 'subjects' | 'offerings' | 'periods' | 'rooms' | 'calendar';
interface Col { key: string; label: string; render?: (r: Record<string, unknown>) => React.ReactNode }
interface Cfg { path: string; title: string; hint: string; cols: Col[]; fields: FieldDef[]; toForm?: (r: Record<string, unknown>) => Record<string, unknown> }

export default function Academics() {
  const { institution } = useAuth();
  const college = institution?.type !== 'school' && institution?.type !== 'coaching';
  const [tab, setTab] = useState<Tab>('years');
  const years = useYears(); const depts = useDepts(); const levels = useLevels(); const subjects = useSubjects(); const staff = useStaffLite(); const sections = useSectionOptions();
  const programmes = useQuery({ queryKey: ['lookup', 'programmes'], queryFn: async () => (await api.get<{ id: string; name: string }[]>('/academic/programmes?pageSize=200')).data });
  const opt = <T extends { id: string }>(xs: T[] | undefined, label: (x: T) => string) => (xs ?? []).map((x) => ({ value: x.id, label: label(x) }));
  const yearOpts = opt(years.data, (y) => y.name); const deptOpts = opt(depts.data, (d) => d.name); const levelOpts = opt(levels.data, (l) => l.name);
  const subjOpts = opt(subjects.data, (s) => `${s.name} (${s.code})`); const staffOpts = opt(staff.data, (s) => s.fullName); const progOpts = opt(programmes.data, (p) => p.name);
  const name = (xs: { value: string; label: string }[], id: unknown) => xs.find((x) => x.value === id)?.label ?? '—';
  const curYear = years.data?.find((y) => y.isCurrent)?.id;

  const cfgs: Record<Tab, Cfg> = {
    years: { path: '/academic/years', title: 'Academic years', hint: 'Exactly one year is current; attendance and reports default to it.', cols: [{ key: 'name', label: 'Name' }, { key: 'startDate', label: 'Start', render: (r) => fmtDate(r.startDate as string) }, { key: 'endDate', label: 'End', render: (r) => fmtDate(r.endDate as string) }, { key: 'isCurrent', label: '', render: (r) => r.isCurrent ? <Badge className="bg-emerald-100 text-emerald-800">Current</Badge> : null }],
      fields: [{ name: 'name', label: 'Name', required: true, placeholder: '2026-2027' }, { name: 'startDate', label: 'Start date', type: 'date', required: true, half: true }, { name: 'endDate', label: 'End date', type: 'date', required: true, half: true }, { name: 'isCurrent', label: 'Current academic year', type: 'checkbox' }] },
    terms: { path: '/academic/terms', title: college ? 'Semesters' : 'Terms', hint: 'Divisions of an academic year.', cols: [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Type' }, { key: 'academicYearId', label: 'Year', render: (r) => name(yearOpts, r.academicYearId) }, { key: 'startDate', label: 'Dates', render: (r) => `${fmtDate(r.startDate as string)} – ${fmtDate(r.endDate as string)}` }],
      fields: [{ name: 'academicYearId', label: 'Academic year', type: 'select', options: yearOpts, required: true }, { name: 'name', label: 'Name', required: true, half: true }, { name: 'kind', label: 'Type', type: 'select', options: ['term', 'semester', 'trimester', 'quarter'].map((k) => ({ value: k, label: titleCase(k) })), required: true, half: true }, { name: 'startDate', label: 'Start', type: 'date', required: true, half: true }, { name: 'endDate', label: 'End', type: 'date', required: true, half: true }] },
    departments: { path: '/academic/departments', title: 'Departments', hint: 'Used for HOD access, reports and subject ownership.', cols: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'headStaffId', label: 'Head', render: (r) => name(staffOpts, r.headStaffId) }],
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', required: true, half: true }, { name: 'headStaffId', label: 'Head of department', type: 'select', options: staffOpts, half: true }] },
    programmes: { path: '/academic/programmes', title: 'Programmes', hint: 'Degree or diploma programmes (colleges).', cols: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'departmentId', label: 'Department', render: (r) => name(deptOpts, r.departmentId) }, { key: 'durationYears', label: 'Years' }],
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', required: true, half: true }, { name: 'durationYears', label: 'Duration (years)', type: 'number', half: true }, { name: 'departmentId', label: 'Department', type: 'select', options: deptOpts }] },
    levels: { path: '/academic/class-levels', title: college ? 'Years of study' : 'Classes / grades', hint: college ? 'e.g. CSE Year III' : 'e.g. Grade 10', cols: [{ key: 'name', label: 'Name' }, { key: 'ordinal', label: 'Order' }, { key: 'programmeId', label: 'Programme', render: (r) => name(progOpts, r.programmeId) }],
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'ordinal', label: 'Sort order', type: 'number', half: true }, { name: 'programmeId', label: 'Programme', type: 'select', options: progOpts, half: true }] },
    sections: { path: '/academic/sections', title: 'Sections', hint: 'A class in a given year, with its class teacher.', cols: [{ key: 'name', label: 'Section', render: (r) => sections.label(r.id as string) || `${name(levelOpts, r.classLevelId)} ${r.name}` }, { key: 'academicYearId', label: 'Year', render: (r) => name(yearOpts, r.academicYearId) }, { key: 'classTeacherStaffId', label: 'Class teacher', render: (r) => name(staffOpts, r.classTeacherStaffId) }, { key: 'departmentId', label: 'Department', render: (r) => name(deptOpts, r.departmentId) }],
      fields: [{ name: 'academicYearId', label: 'Academic year', type: 'select', options: yearOpts, required: true, half: true }, { name: 'classLevelId', label: college ? 'Year of study' : 'Class', type: 'select', options: levelOpts, required: true, half: true }, { name: 'name', label: 'Section name', required: true, half: true, placeholder: 'A' }, { name: 'capacity', label: 'Capacity', type: 'number', half: true }, { name: 'classTeacherStaffId', label: 'Class teacher', type: 'select', options: staffOpts, half: true }, { name: 'departmentId', label: 'Department', type: 'select', options: deptOpts, half: true }],
      toForm: (r) => ({ ...r }) },
    subjects: { path: '/academic/subjects', title: 'Subjects', hint: 'Theory, lab and practical subjects. Labs can be counted separately in attendance.', cols: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'kind', label: 'Type' }, { key: 'departmentId', label: 'Department', render: (r) => name(deptOpts, r.departmentId) }, { key: 'isElective', label: '', render: (r) => r.isElective ? <Badge>Elective</Badge> : null }],
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', required: true, half: true }, { name: 'kind', label: 'Type', type: 'select', options: ['theory', 'lab', 'practical', 'activity', 'other'].map((k) => ({ value: k, label: titleCase(k) })), required: true, half: true }, { name: 'departmentId', label: 'Department', type: 'select', options: deptOpts, half: true }, { name: 'credits', label: 'Credits', half: true, placeholder: '3.0' }, { name: 'isElective', label: 'Elective', type: 'checkbox' }] },
    offerings: { path: `/academic/offerings${curYear ? `?academicYearId=${curYear}&pageSize=500` : '?pageSize=500'}`, title: 'Classes taught (subject allocation)', hint: 'Who teaches which subject to which section. Uncheck "whole section" for electives and enrol students individually.', cols: [{ key: 'subjectId', label: 'Subject', render: (r) => name(subjOpts, r.subjectId) }, { key: 'sectionId', label: 'Section', render: (r) => sections.label(r.sectionId as string) || (r.label as string) || 'Elective group' }, { key: 'staffId', label: 'Faculty', render: (r) => name(staffOpts, r.staffId) }],
      fields: [{ name: 'academicYearId', label: 'Academic year', type: 'select', options: yearOpts, required: true, half: true }, { name: 'subjectId', label: 'Subject', type: 'select', options: subjOpts, required: true, half: true }, { name: 'sectionId', label: 'Section', type: 'select', options: sections.options, half: true }, { name: 'staffId', label: 'Faculty', type: 'select', options: staffOpts, half: true }, { name: 'label', label: 'Label (for elective groups)' }, { name: 'autoEnrolSection', label: 'Whole section attends', type: 'checkbox' }] },
    periods: { path: '/academic/periods', title: 'Periods (bell schedule)', hint: 'Daily time slots used by the timetable. Breaks cannot hold classes.', cols: [{ key: 'ordinal', label: '#' }, { key: 'name', label: 'Name' }, { key: 'startTime', label: 'Time', render: (r) => `${fmtTime(r.startTime as string)}–${fmtTime(r.endTime as string)}` }, { key: 'isBreak', label: '', render: (r) => r.isBreak ? <Badge>Break</Badge> : null }],
      fields: [{ name: 'name', label: 'Name', required: true, half: true }, { name: 'ordinal', label: 'Order', type: 'number', required: true, half: true }, { name: 'startTime', label: 'Start', type: 'time', required: true, half: true }, { name: 'endTime', label: 'End', type: 'time', required: true, half: true }, { name: 'isBreak', label: 'Break (no classes)', type: 'checkbox' }] },
    rooms: { path: '/academic/rooms', title: 'Rooms & labs', hint: 'Used for room double-booking checks.', cols: [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Type' }, { key: 'capacity', label: 'Capacity' }],
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'kind', label: 'Type', type: 'select', options: ['classroom', 'lab', 'hall', 'other'].map((k) => ({ value: k, label: titleCase(k) })), required: true, half: true }, { name: 'capacity', label: 'Capacity', type: 'number', half: true }] },
    calendar: { path: '/academic/calendar', title: 'Academic calendar', hint: 'Holidays and vacations stop attendance being expected and are excluded per policy.', cols: [{ key: 'title', label: 'Event' }, { key: 'kind', label: 'Type', render: (r) => titleCase(r.kind as string) }, { key: 'startDate', label: 'Dates', render: (r) => r.startDate === r.endDate ? fmtDate(r.startDate as string) : `${fmtDate(r.startDate as string)} – ${fmtDate(r.endDate as string)}` }, { key: 'departmentId', label: 'Applies to', render: (r) => r.departmentId ? name(deptOpts, r.departmentId) : 'Whole institution' }],
      fields: [{ name: 'title', label: 'Title', required: true }, { name: 'kind', label: 'Type', type: 'select', required: true, options: ['holiday', 'exam', 'event', 'vacation', 'special_working_day', 'half_day'].map((k) => ({ value: k, label: titleCase(k) })) }, { name: 'startDate', label: 'From', type: 'date', required: true, half: true }, { name: 'endDate', label: 'To', type: 'date', required: true, half: true }, { name: 'departmentId', label: 'Only for department (optional)', type: 'select', options: deptOpts }] },
  };
  const tabs: { key: Tab; label: string }[] = [
    { key: 'years', label: 'Years' }, { key: 'terms', label: college ? 'Semesters' : 'Terms' }, { key: 'departments', label: 'Departments' },
    ...(college ? [{ key: 'programmes' as Tab, label: 'Programmes' }] : []),
    { key: 'levels', label: college ? 'Years of study' : 'Classes' }, { key: 'sections', label: 'Sections' }, { key: 'subjects', label: 'Subjects' }, { key: 'offerings', label: 'Subject allocation' },
    { key: 'periods', label: 'Periods' }, { key: 'rooms', label: 'Rooms' }, { key: 'calendar', label: 'Calendar' },
  ];
  return (
    <div>
      <PageHeader title="Academic setup" subtitle="Your institution's structure. Changes are audited." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <EntityTable key={tab} cfg={cfgs[tab]} />
    </div>
  );
}

function EntityTable({ cfg }: { cfg: Cfg }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState<Record<string, unknown> | 'new' | null>(null);
  const [del, setDel] = useState<Record<string, unknown> | null>(null);
  const path = cfg.path.includes('?') ? cfg.path : `${cfg.path}?pageSize=500`;
  const base = cfg.path.split('?')[0];
  const q = useQuery({ queryKey: ['entity', path], queryFn: () => api.get<Record<string, unknown>[]>(path) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['entity'] }); qc.invalidateQueries({ queryKey: ['lookup'] }); };
  const strip = (r: Record<string, unknown>) => Object.fromEntries(cfg.fields.map((f) => [f.name, r[f.name] ?? (f.type === 'checkbox' ? false : '')]));
  return (
    <Card title={cfg.title} actions={<Button size="sm" onClick={() => setEdit('new')}><Plus className="h-4 w-4" />Add</Button>} bodyClass="p-0">
      <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">{cfg.hint}</p>
      <QueryState q={q} empty={q.data?.data.length === 0 ? <Empty title={`No ${cfg.title.toLowerCase()} yet`} action={<Button size="sm" onClick={() => setEdit('new')}>Add the first one</Button>} /> : undefined}>
        <div className="overflow-x-auto"><table className="w-full min-w-[560px]">
          <thead className="bg-slate-50"><tr>{cfg.cols.map((c) => <th key={c.key} className="th">{c.label}</th>)}<th className="th w-28" /></tr></thead>
          <tbody className="divide-y divide-slate-100">{q.data?.data.map((r) => (
            <tr key={r.id as string} className="hover:bg-slate-50">
              {cfg.cols.map((c) => <td key={c.key} className="td">{c.render ? c.render(r) : String(r[c.key] ?? '—')}</td>)}
              <td className="td text-right whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => setEdit(r)}>Edit</Button><button className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => setDel(r)} aria-label="Delete"><Trash2 className="h-4 w-4" /></button></td>
            </tr>))}</tbody>
        </table></div>
      </QueryState>
      <FormModal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? `Add to ${cfg.title.toLowerCase()}` : `Edit`} fields={cfg.fields} wide={cfg.fields.length > 4}
        initial={edit && edit !== 'new' ? strip(edit) : cfg.fields.some((f) => f.name === 'autoEnrolSection') ? { autoEnrolSection: true } : undefined}
        onSubmit={async (v) => { if (edit === 'new') await api.post(base, v); else await api.patch(`${base}/${(edit as Record<string, unknown>).id}`, v); toast.success('Saved'); refresh(); }} />
      <Confirm open={!!del} onClose={() => setDel(null)} danger title="Delete this item?" confirmLabel="Delete" message="Items that other records depend on (for example a section with attendance) may be removed with them. This is audited."
        onConfirm={async () => { try { await api.delete(`${base}/${del!.id}`); toast.success('Deleted'); refresh(); } catch (e) { toast.error(e); } setDel(null); }} />
    </Card>
  );
}
