/**
 * Demo data seed. Creates two clearly-labelled demo tenants (is_demo = true) and a platform admin.
 * Re-running deletes and recreates ONLY demo tenants and demo accounts (emails ending in .example).
 *
 *   npm run db:seed            # full size (500 + 1,200 students)
 *   SEED_SCALE=0.2 npm run db:seed   # smaller, faster
 */
import crypto from 'node:crypto';
import { pool, db } from '../client.js';
import { runMigrations } from '../migrate.js';
import { hashPassword } from '../../lib/security.js';
import { provisionInstitution, type InstitutionType } from '../../modules/institutions/provision.js';
import { users } from '../schema/index.js';
import { addDays, eachDate, isoWeekday, todayIn } from '../../lib/dates.js';
import { bulkInsert, FIRST, LAST, rng } from './util.js';

export const DEMO_PASSWORD = 'Demo@AttendIQ2026';
const uuid = (): string => crypto.randomUUID();
const SCALE = Number(process.env.SEED_SCALE ?? '1');

interface LevelCfg { name: string; ordinal: number; dept?: string; subjects: { name: string; code: string; kind: 'theory' | 'lab'; hours: number }[] }
interface Cfg {
  key: string; name: string; slug: string; type: InstitutionType; domain: string; seed: number;
  departments: { name: string; code: string }[];
  programmes?: { dept: string; name: string; code: string }[];
  levels: LevelCfg[];
  sectionNames: string[];
  studentsPerSection: number;
  staffCount: number;
  periods: { name: string; start: string; end: string; isBreak?: boolean }[];
  mode: 'daily' | 'period';
  attendanceFrom: string;
}

const today = todayIn('Asia/Kolkata');
const HOLIDAYS = [
  { title: 'Gandhi Jayanti', date: '2026-10-02' },
  { title: 'Vijayadashami', date: '2026-10-20' },
  { title: 'Deepavali', date: '2026-11-09' },
];

const schoolSubjects = (g: number) => {
  const base = [
    { name: 'English', code: 'ENG', kind: 'theory' as const, hours: 6 },
    { name: 'Tamil', code: 'TAM', kind: 'theory' as const, hours: 5 },
    { name: 'Mathematics', code: 'MAT', kind: 'theory' as const, hours: 7 },
  ];
  if (g <= 10) return [...base, { name: 'Science', code: 'SCI', kind: 'theory' as const, hours: 7 }, { name: 'Social Science', code: 'SOC', kind: 'theory' as const, hours: 5 }, { name: 'Computer Science', code: 'CSC', kind: 'lab' as const, hours: 2 }];
  return [...base.filter((b) => b.code !== 'TAM'), { name: 'Physics', code: 'PHY', kind: 'theory' as const, hours: 6 }, { name: 'Chemistry', code: 'CHE', kind: 'theory' as const, hours: 6 }, { name: 'Biology', code: 'BIO', kind: 'theory' as const, hours: 5 }, { name: 'Computer Science', code: 'CSC', kind: 'lab' as const, hours: 3 }];
};

const SCHOOL: Cfg = {
  key: 'school', name: 'ABC International School (Demo)', slug: 'abc-international-demo', type: 'school', domain: 'abc-school.example', seed: 42,
  departments: [{ name: 'Languages', code: 'LANG' }, { name: 'Mathematics', code: 'MATH' }, { name: 'Science', code: 'SCI' }, { name: 'Social Science', code: 'SOC' }, { name: 'Computer Science', code: 'CS' }],
  levels: [6, 7, 8, 9, 10, 11, 12].map((g) => ({ name: `Grade ${g}`, ordinal: g, subjects: schoolSubjects(g) })),
  sectionNames: ['A', 'B'], studentsPerSection: Math.round(36 * SCALE) || 4, staffCount: Math.max(12, Math.round(30 * SCALE)),
  periods: [
    { name: 'Period 1', start: '08:30', end: '09:15' }, { name: 'Period 2', start: '09:15', end: '10:00' }, { name: 'Period 3', start: '10:00', end: '10:45' },
    { name: 'Break', start: '10:45', end: '11:00', isBreak: true }, { name: 'Period 4', start: '11:00', end: '11:45' }, { name: 'Period 5', start: '11:45', end: '12:30' },
    { name: 'Lunch', start: '12:30', end: '13:15', isBreak: true }, { name: 'Period 6', start: '13:15', end: '14:00' }, { name: 'Period 7', start: '14:00', end: '14:45' },
  ],
  mode: 'daily', attendanceFrom: '2026-08-17',
};

const engSubjects = (dept: string, year: number) => {
  const map: Record<string, string[][]> = {
    CSE: [['Engineering Mathematics I', 'Programming in C', 'Engineering Physics', 'Engineering Graphics', 'Communicative English'], ['Discrete Mathematics', 'Data Structures', 'Digital Logic', 'Object Oriented Programming', 'Environmental Science'], ['Machine Learning', 'Database Management Systems', 'Computer Networks', 'Operating Systems', 'Theory of Computation'], ['Cloud Computing', 'Compiler Design', 'Information Security', 'Deep Learning', 'Professional Ethics']],
    ECE: [['Engineering Mathematics I', 'Basic Electrical Engineering', 'Engineering Physics', 'Engineering Graphics', 'Communicative English'], ['Signals and Systems', 'Electronic Devices', 'Network Analysis', 'Digital Electronics', 'Environmental Science'], ['Analog Communication', 'Microprocessors', 'Control Systems', 'Linear Integrated Circuits', 'Electromagnetic Fields'], ['VLSI Design', 'Wireless Communication', 'Embedded Systems', 'Optical Communication', 'Professional Ethics']],
    MECH: [['Engineering Mathematics I', 'Engineering Mechanics', 'Engineering Physics', 'Engineering Graphics', 'Communicative English'], ['Thermodynamics', 'Strength of Materials', 'Manufacturing Technology', 'Fluid Mechanics', 'Environmental Science'], ['Heat Transfer', 'Design of Machine Elements', 'Dynamics of Machinery', 'Metrology', 'Thermal Engineering'], ['Finite Element Analysis', 'Automobile Engineering', 'Mechatronics', 'Operations Research', 'Professional Ethics']],
    CIVIL: [['Engineering Mathematics I', 'Engineering Mechanics', 'Engineering Chemistry', 'Engineering Graphics', 'Communicative English'], ['Surveying', 'Strength of Materials', 'Fluid Mechanics', 'Construction Materials', 'Environmental Science'], ['Structural Analysis', 'Geotechnical Engineering', 'Transportation Engineering', 'Water Resources', 'Concrete Technology'], ['Design of Steel Structures', 'Estimation and Costing', 'Environmental Engineering', 'Remote Sensing', 'Professional Ethics']],
  };
  const labs: Record<string, string[]> = { CSE: ['Programming Lab', 'Data Structures Lab', 'DBMS Lab', 'Cloud Lab'], ECE: ['Electrical Lab', 'Devices Lab', 'Microprocessor Lab', 'VLSI Lab'], MECH: ['Workshop', 'Materials Lab', 'Thermal Lab', 'CAD Lab'], CIVIL: ['Workshop', 'Survey Lab', 'Soil Mechanics Lab', 'CAD Lab'] };
  return [
    ...map[dept][year - 1].map((n, i) => ({ name: n, code: `${dept}${year}0${i + 1}`, kind: 'theory' as const, hours: 6 })),
    { name: labs[dept][year - 1], code: `${dept}${year}L1`, kind: 'lab' as const, hours: 4 },
  ];
};

const COLLEGE: Cfg = {
  key: 'college', name: 'XYZ College of Engineering (Demo)', slug: 'xyz-engineering-demo', type: 'college', domain: 'xyz-college.example', seed: 7,
  departments: [{ name: 'Computer Science and Engineering', code: 'CSE' }, { name: 'Electronics and Communication Engineering', code: 'ECE' }, { name: 'Mechanical Engineering', code: 'MECH' }, { name: 'Civil Engineering', code: 'CIVIL' }],
  programmes: [{ dept: 'CSE', name: 'B.E. Computer Science and Engineering', code: 'BE-CSE' }, { dept: 'ECE', name: 'B.E. Electronics and Communication', code: 'BE-ECE' }, { dept: 'MECH', name: 'B.E. Mechanical Engineering', code: 'BE-MECH' }, { dept: 'CIVIL', name: 'B.E. Civil Engineering', code: 'BE-CIVIL' }],
  levels: ['CSE', 'ECE', 'MECH', 'CIVIL'].flatMap((d) => [1, 2, 3, 4].map((y) => ({ name: `${d} Year ${['I', 'II', 'III', 'IV'][y - 1]}`, ordinal: y, dept: d, subjects: engSubjects(d, y) }))),
  sectionNames: ['A', 'B'], studentsPerSection: Math.round(37.5 * SCALE) || 4, staffCount: Math.max(24, Math.round(80 * SCALE)),
  periods: [
    { name: 'Hour 1', start: '09:00', end: '09:50' }, { name: 'Hour 2', start: '09:50', end: '10:40' }, { name: 'Tea Break', start: '10:40', end: '10:55', isBreak: true },
    { name: 'Hour 3', start: '10:55', end: '11:45' }, { name: 'Hour 4', start: '11:45', end: '12:35' }, { name: 'Lunch', start: '12:35', end: '13:20', isBreak: true },
    { name: 'Hour 5', start: '13:20', end: '14:10' }, { name: 'Hour 6', start: '14:10', end: '15:00' },
  ],
  mode: 'period', attendanceFrom: '2026-09-28',
};

async function resetDemo() {
  await pool.query(`delete from institutions where is_demo = true`);
  await pool.query(`delete from users where email like '%.example'`);
}

async function seedInstitution(cfg: Cfg, demoHash: string) {
  const R = rng(cfg.seed);
  const t0 = Date.now();
  const [owner] = await db.insert(users).values({ email: `owner@${cfg.domain}`, fullName: cfg.type === 'school' ? 'Lakshmi Narayanan' : 'Dr. Rajesh Varma', passwordHash: demoHash }).returning();
  const { institution: inst, roleIds } = await db.transaction((tx) => provisionInstitution(tx, { name: cfg.name, type: cfg.type, slug: cfg.slug, ownerUserId: owner.id, isDemo: true, contactEmail: `office@${cfg.domain}`, contactPhone: '+91 44 0000 0000', address: 'Chennai, Tamil Nadu (demo address)', planCode: cfg.type === 'school' ? 'professional' : 'enterprise' }));
  const I = inst.id;
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`update institutions set primary_color = $2 where id = $1`, [I, cfg.type === 'school' ? '#1e3a8a' : '#0f4c5c']);
    await c.query(`update institution_settings set notification_settings = $2 where institution_id = $1`, [I, JSON.stringify({ notifyAbsent: true, notifyLate: true, channels: ['in_app'] })]);
    if (cfg.type === 'school') await c.query(`update institution_settings set modules = modules || '{"periodAttendance": false}'::jsonb where institution_id = $1`, [I]);

    const userRows: unknown[][] = [];
    const membershipRows: unknown[][] = [];
    const userRoleRows: unknown[][] = [];
    const addUser = (email: string, name: string, roleKey: string, phone: string | null = null) => {
      const u = uuid(); const m = uuid();
      userRows.push([u, email, demoHash, name, phone]);
      membershipRows.push([m, I, u]);
      userRoleRows.push([m, roleIds[roleKey]]);
      return u;
    };
    addUser(`admin@${cfg.domain}`, cfg.type === 'school' ? 'Suresh Babu' : 'Anitha Krishnan', 'admin');
    addUser(`principal@${cfg.domain}`, cfg.type === 'school' ? 'Dr. Meenakshi Sundaram' : 'Dr. Venkatesh Iyer', 'principal');

    // Academic year and term
    const yearId = uuid();
    await c.query(`insert into academic_years (id, institution_id, name, start_date, end_date, is_current) values ($1,$2,'2026-2027','2026-06-01','2027-04-30',true)`, [yearId, I]);
    const termId = uuid();
    if (cfg.type === 'school') await c.query(`insert into academic_terms (id, institution_id, academic_year_id, name, kind, start_date, end_date) values ($1,$2,$3,'Term 2','term','2026-10-05','2026-12-23')`, [termId, I, yearId]);
    else await c.query(`insert into academic_terms (id, institution_id, academic_year_id, name, kind, start_date, end_date) values ($1,$2,$3,'Odd Semester','semester','2026-07-15','2026-12-15')`, [termId, I, yearId]);

    const deptIds: Record<string, string> = {};
    await bulkInsert(c, 'departments', ['id', 'institution_id', 'name', 'code'], cfg.departments.map((d) => { deptIds[d.code] = uuid(); return [deptIds[d.code], I, d.name, d.code]; }));
    const progIds: Record<string, string> = {};
    if (cfg.programmes) await bulkInsert(c, 'programmes', ['id', 'institution_id', 'department_id', 'name', 'code', 'duration_years'], cfg.programmes.map((p) => { progIds[p.dept] = uuid(); return [progIds[p.dept], I, deptIds[p.dept], p.name, p.code, 4]; }));

    // Periods
    const periodRows = cfg.periods.map((p, i) => ({ id: uuid(), ...p, ordinal: i + 1 }));
    await bulkInsert(c, 'periods', ['id', 'institution_id', 'name', 'ordinal', 'start_time', 'end_time', 'is_break'], periodRows.map((p) => [p.id, I, p.name, p.ordinal, p.start, p.end, !!p.isBreak]));
    const teaching = periodRows.filter((p) => !p.isBreak);

    // Staff
    const deptCodes = cfg.departments.map((d) => d.code);
    const staffList: { id: string; userId: string; dept: string; name: string }[] = [];
    const staffRows: unknown[][] = [];
    for (let i = 0; i < cfg.staffCount; i++) {
      const dept = deptCodes[i % deptCodes.length];
      const name = `${cfg.type === 'college' ? (R.chance(0.5) ? 'Dr. ' : 'Prof. ') : ''}${R.pick(FIRST)} ${R.pick(LAST)}`;
      const isHod = cfg.type === 'college' && i < deptCodes.length;
      const email = i === (cfg.type === 'college' ? deptCodes.length : 0) ? `teacher@${cfg.domain}` : `staff${i + 1}@${cfg.domain}`;
      const userId = addUser(email, name, isHod ? 'hod' : cfg.type === 'school' ? 'class_teacher' : 'faculty', `9${String(800000000 + i).padStart(9, '0')}`);
      const id = uuid();
      staffList.push({ id, userId, dept, name });
      staffRows.push([id, I, userId, `${cfg.key === 'school' ? 'T' : 'F'}${String(1001 + i)}`, name, email, isHod ? 'Professor & Head' : cfg.type === 'school' ? R.pick(['PG Assistant', 'BT Assistant', 'Senior Teacher']) : R.pick(['Assistant Professor', 'Associate Professor']), deptIds[dept], '2019-06-01', true]);
    }
    await bulkInsert(c, 'users', ['id', 'email', 'password_hash', 'full_name', 'phone'], userRows.splice(0));
    await bulkInsert(c, 'institution_users', ['id', 'institution_id', 'user_id'], membershipRows.splice(0));
    await bulkInsert(c, 'user_roles', ['membership_id', 'role_id'], userRoleRows.splice(0));
    await bulkInsert(c, 'staff', ['id', 'institution_id', 'user_id', 'employee_id', 'full_name', 'email', 'designation', 'department_id', 'joining_date', 'is_demo'], staffRows);
    if (cfg.type === 'college') for (let i = 0; i < deptCodes.length; i++) await c.query(`update departments set head_staff_id = $1 where id = $2`, [staffList[i].id, deptIds[deptCodes[i]]]);

    // Rooms
    const roomRows: unknown[][] = [];
    const roomIds: string[] = []; const labIds: string[] = [];
    for (let i = 1; i <= cfg.levels.length * cfg.sectionNames.length; i++) { const id = uuid(); roomIds.push(id); roomRows.push([id, I, `${cfg.type === 'school' ? 'Room' : 'LH'} ${100 + i}`, 'classroom', 45]); }
    for (let i = 1; i <= Math.max(3, Math.ceil(cfg.levels.length / 2)); i++) { const id = uuid(); labIds.push(id); roomRows.push([id, I, `Lab ${i}`, 'lab', 40]); }
    await bulkInsert(c, 'rooms', ['id', 'institution_id', 'name', 'kind', 'capacity'], roomRows);

    // Levels, sections, subjects, offerings, timetable
    const subjectIds = new Map<string, string>();
    const subjectRows: unknown[][] = []; const levelRows: unknown[][] = []; const sectionRows: unknown[][] = []; const offeringRows: unknown[][] = []; const ttRows: unknown[][] = [];
    const sections: { id: string; label: string; dept: string; classTeacher: string; offerings: { id: string; subjectId: string; staffId: string; kind: string }[] }[] = [];
    const busy = new Set<string>(); // staffId|dow|periodId
    const roomBusy = new Set<string>();
    let ctIndex = 0; let roomIdx = 0;
    const staffByDept = (d: string) => staffList.filter((s) => s.dept === d);
    const schoolSubjectDept: Record<string, string> = { ENG: 'LANG', TAM: 'LANG', MAT: 'MATH', SCI: 'SCI', PHY: 'SCI', CHE: 'SCI', BIO: 'SCI', SOC: 'SOC', CSC: 'CS' };
    const load = new Map<string, number>();
    for (const lv of cfg.levels) {
      const levelId = uuid();
      levelRows.push([levelId, I, lv.dept ? progIds[lv.dept] : null, lv.name, lv.ordinal]);
      for (const sub of lv.subjects) {
        if (!subjectIds.has(sub.code)) {
          const id = uuid(); subjectIds.set(sub.code, id);
          subjectRows.push([id, I, deptIds[lv.dept ?? schoolSubjectDept[sub.code]], sub.name, sub.code, sub.kind, sub.kind === 'lab' ? '2.0' : '3.0']);
        }
      }
      for (const sn of cfg.sectionNames) {
        const secId = uuid();
        const dept = lv.dept ?? deptCodes[ctIndex % deptCodes.length];
        const ct = cfg.type === 'school' ? staffList[ctIndex % staffList.length] : staffByDept(dept)[(ctIndex % staffByDept(dept).length)];
        ctIndex++;
        sectionRows.push([secId, I, yearId, levelId, cfg.type === 'college' ? termId : null, lv.dept ? deptIds[lv.dept] : null, sn, ct.id, 60]);
        const roomId = roomIds[roomIdx++ % roomIds.length];
        const sec = { id: secId, label: `${lv.name} ${sn}`, dept, classTeacher: ct.id, offerings: [] as { id: string; subjectId: string; staffId: string; kind: string }[] };
        const secBusy = new Set<string>();
        for (const sub of lv.subjects) {
          const pool_ = staffByDept(lv.dept ?? schoolSubjectDept[sub.code]);
          const candidates = [...pool_].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0));
          let placedStaff: string | null = null;
          for (const cand of candidates) {
            // Try to place all hours for this candidate.
            const slots: { dow: number; periodId: string }[] = [];
            const tried = new Set<string>();
            for (let attempt = 0; attempt < 200 && slots.length < sub.hours; attempt++) {
              const dow = R.int(1, 6); const p = R.pick(teaching);
              const k = `${dow}|${p.id}`;
              if (tried.has(k)) continue; tried.add(k);
              if (secBusy.has(k) || busy.has(`${cand.id}|${k}`) || slots.some((s) => s.dow === dow && s.periodId === p.id)) continue;
              if (slots.filter((s) => s.dow === dow).length >= (sub.kind === 'lab' ? 2 : 2)) continue;
              slots.push({ dow, periodId: p.id });
            }
            if (slots.length < Math.ceil(sub.hours * 0.75)) continue;
            placedStaff = cand.id;
            const offId = uuid();
            offeringRows.push([offId, I, yearId, cfg.type === 'college' ? termId : null, subjectIds.get(sub.code), secId, cand.id, true]);
            for (const s of slots) {
              const k = `${s.dow}|${s.periodId}`;
              secBusy.add(k); busy.add(`${cand.id}|${k}`);
              let rid: string | null = sub.kind === 'lab' ? (labIds.find((l) => !roomBusy.has(`${l}|${k}`)) ?? null) : roomId;
              if (rid && roomBusy.has(`${rid}|${k}`)) rid = null;
              if (rid) roomBusy.add(`${rid}|${k}`);
              ttRows.push([uuid(), I, yearId, offId, s.dow, s.periodId, rid]);
            }
            load.set(cand.id, (load.get(cand.id) ?? 0) + slots.length);
            sec.offerings.push({ id: offId, subjectId: subjectIds.get(sub.code)!, staffId: cand.id, kind: sub.kind });
            break;
          }
          if (!placedStaff) console.warn(`  could not schedule ${sub.code} for ${sec.label}`);
        }
        sections.push(sec);
      }
    }
    await bulkInsert(c, 'class_levels', ['id', 'institution_id', 'programme_id', 'name', 'ordinal'], levelRows);
    await bulkInsert(c, 'subjects', ['id', 'institution_id', 'department_id', 'name', 'code', 'kind', 'credits'], subjectRows);
    await bulkInsert(c, 'sections', ['id', 'institution_id', 'academic_year_id', 'class_level_id', 'term_id', 'department_id', 'name', 'class_teacher_staff_id', 'capacity'], sectionRows);
    await bulkInsert(c, 'course_offerings', ['id', 'institution_id', 'academic_year_id', 'term_id', 'subject_id', 'section_id', 'staff_id', 'auto_enrol_section'], offeringRows);
    await bulkInsert(c, 'timetable_entries', ['id', 'institution_id', 'academic_year_id', 'course_offering_id', 'day_of_week', 'period_id', 'room_id'], ttRows);

    // Students, guardians, logins
    type Profile = 'regular' | 'high' | 'shortage' | 'declining' | 'streak';
    const students: { id: string; sectionId: string; profile: Profile; p: number; userId: string | null; guardianUserId: string | null; name: string }[] = [];
    const stRows: unknown[][] = []; const enRows: unknown[][] = []; const gRows: unknown[][] = []; const sgRows: unknown[][] = [];
    let adm = 1;
    let loginCount = 0;
    for (const sec of sections) {
      for (let r = 1; r <= cfg.studentsPerSection; r++) {
        const id = uuid();
        const first = R.pick(FIRST); const last = R.pick(LAST);
        const roll = R.next();
        const profile: Profile = roll < 0.62 ? 'regular' : roll < 0.8 ? 'high' : roll < 0.9 ? 'shortage' : roll < 0.96 ? 'declining' : 'streak';
        const p = profile === 'high' ? 0.97 + R.next() * 0.03 : profile === 'regular' ? 0.86 + R.next() * 0.1 : profile === 'shortage' ? 0.55 + R.next() * 0.17 : 0.9;
        // Give a portal login to the first two students of every section (and their guardians).
        let userId: string | null = null; let gUser: string | null = null;
        const isFirstDemo = loginCount === 0;
        if (r <= 2) {
          const sEmail = isFirstDemo ? `student@${cfg.domain}` : `student${adm}@${cfg.domain}`;
          userId = addUser(sEmail, `${first} ${last}`, 'student');
          const gEmail = isFirstDemo ? `parent@${cfg.domain}` : `parent${adm}@${cfg.domain}`;
          gUser = addUser(gEmail, `${R.pick(FIRST)} ${last}`, 'parent', `9${String(700000000 + adm).padStart(9, '0')}`);
          loginCount++;
        }
        const dobYear = cfg.type === 'school' ? 2026 - (sec.label.match(/\d+/) ? Number(sec.label.match(/Grade (\d+)/)?.[1] ?? 10) : 10) - 5 : 2008 - (sec.label.includes('IV') ? 3 : sec.label.includes('III') ? 2 : sec.label.includes('II') ? 1 : 0);
        stRows.push([id, I, userId, `${cfg.key === 'school' ? 'ABC' : 'XYZ'}${String(2026000 + adm)}`, first, last, `${dobYear}-${String(R.int(1, 12)).padStart(2, '0')}-${String(R.int(1, 28)).padStart(2, '0')}`, R.pick(['female', 'male']), '2026-06-01', 'active', true]);
        enRows.push([uuid(), I, id, yearId, sec.id, String(r), '2026-06-01']);
        const gid = uuid();
        gRows.push([gid, I, gUser, `${R.pick(FIRST)} ${last}`, `9${String(700000000 + adm).padStart(9, '0')}`, gUser ? null : null, true]);
        sgRows.push([uuid(), I, id, gid, R.pick(['father', 'mother', 'guardian']), true]);
        students.push({ id, sectionId: sec.id, profile, p, userId, guardianUserId: gUser, name: `${first} ${last}` });
        adm++;
      }
    }
    await bulkInsert(c, 'users', ['id', 'email', 'password_hash', 'full_name', 'phone'], userRows.splice(0));
    await bulkInsert(c, 'institution_users', ['id', 'institution_id', 'user_id'], membershipRows.splice(0));
    await bulkInsert(c, 'user_roles', ['membership_id', 'role_id'], userRoleRows.splice(0));
    await bulkInsert(c, 'students', ['id', 'institution_id', 'user_id', 'admission_number', 'first_name', 'last_name', 'date_of_birth', 'gender', 'admission_date', 'status', 'is_demo'], stRows);
    await bulkInsert(c, 'student_enrolments', ['id', 'institution_id', 'student_id', 'academic_year_id', 'section_id', 'roll_number', 'start_date'], enRows);
    await bulkInsert(c, 'guardians', ['id', 'institution_id', 'user_id', 'full_name', 'phone', 'email', 'is_demo'], gRows);
    await bulkInsert(c, 'student_guardians', ['id', 'institution_id', 'student_id', 'guardian_id', 'relationship', 'is_primary'], sgRows);

    // Calendar
    await bulkInsert(c, 'calendar_events', ['id', 'institution_id', 'academic_year_id', 'kind', 'title', 'start_date', 'end_date'], [
      ...HOLIDAYS.map((h) => [uuid(), I, yearId, 'holiday', h.title, h.date, h.date]),
      [uuid(), I, yearId, 'exam', cfg.type === 'school' ? 'Half-yearly examinations' : 'End-semester examinations', '2026-12-07', '2026-12-18'],
      [uuid(), I, yearId, 'vacation', 'Winter vacation', '2026-12-24', '2027-01-01'],
      [uuid(), I, yearId, 'event', cfg.type === 'school' ? 'Annual Sports Day' : 'Technical Symposium', '2026-12-04', '2026-12-04'],
    ]);

    // Attendance
    const holidaySet = new Set(HOLIDAYS.map((h) => h.date));
    const days = eachDate(cfg.attendanceFrom, today).filter((d) => isoWeekday(d) <= 6 && !holidaySet.has(d));
    const last14 = addDays(today, -14);
    const byStudentSection = new Map<string, typeof students>();
    for (const s of students) byStudentSection.set(s.sectionId, [...(byStudentSection.get(s.sectionId) ?? []), s]);
    const leaveTypes = (await c.query<{ id: string; code: string }>(`select id, code from leave_types where institution_id = $1`, [I])).rows;
    const medical = leaveTypes.find((l) => l.code === 'medical')!.id;

    // Pre-plan absence streaks and approved leaves per student.
    const streakDays = new Map<string, Set<string>>();
    const leaveDays = new Map<string, Set<string>>();
    const leaveReqRows: unknown[][] = [];
    const ownerId = owner.id;
    for (const s of students) {
      if (s.profile === 'streak') {
        const end = days.length - 1 - R.int(0, 1); const len = R.int(3, 5);
        streakDays.set(s.id, new Set(days.slice(Math.max(0, end - len + 1), end + 1)));
      }
      if (R.chance(0.08)) {
        const start = R.int(0, Math.max(0, days.length - 10)); const len = R.int(1, 3);
        const ds = days.slice(start, start + len);
        if (ds.length) {
          leaveDays.set(s.id, new Set(ds));
          leaveReqRows.push([uuid(), I, s.id, medical, s.guardianUserId ?? ownerId, ds[0], ds.at(-1), 'Fever – doctor advised rest (demo)', 'approved', ownerId, new Date().toISOString()]);
        }
      }
    }
    const statusFor = (s: typeof students[number], d: string, R2: ReturnType<typeof rng>) => {
      if (streakDays.get(s.id)?.has(d)) return 'absent';
      if (leaveDays.get(s.id)?.has(d)) return 'medical_leave';
      let p = s.p;
      if (s.profile === 'declining' && d >= last14) p = 0.45;
      if (R2.next() < p) return R2.chance(cfg.type === 'school' ? 0.04 : 0.03) ? 'late' : 'present';
      return 'absent';
    };

    const sessionRows: unknown[][] = []; const recordRows: unknown[][] = [];
    const R2 = rng(cfg.seed + 1000);
    const nowIso = new Date().toISOString();
    const ttByDow = new Map<number, { offeringId: string; periodId: string; sectionId: string; staffId: string }[]>();
    for (const sec of sections) for (const o of sec.offerings) for (const t of ttRows.filter((x) => x[3] === o.id)) {
      const dow = t[4] as number;
      ttByDow.set(dow, [...(ttByDow.get(dow) ?? []), { offeringId: o.id, periodId: t[5] as string, sectionId: sec.id, staffId: o.staffId }]);
    }
    const staffUser = new Map(staffList.map((s) => [s.id, s.userId]));
    const periodStart = new Map(teaching.map((p) => [p.id, p.start]));
    const nowHm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    for (const d of days) {
      const isToday = d === today;
      if (cfg.mode === 'daily') {
        for (const sec of sections) {
          // Today: roughly two thirds of registers already submitted, the rest pending.
          if (isToday && R2.chance(0.35)) continue;
          // A few historical gaps for the compliance report.
          if (!isToday && d >= addDays(today, -7) && R2.chance(0.03)) continue;
          const sid = uuid();
          sessionRows.push([sid, I, 'daily', d, sec.id, null, null, sec.classTeacher, 'manual', 'submitted', `${d}T03:30:00Z`, `${d}T03:45:00Z`, staffUser.get(sec.classTeacher), true]);
          for (const s of byStudentSection.get(sec.id) ?? []) recordRows.push([uuid(), I, sid, s.id, statusFor(s, d, R2), 'manual', staffUser.get(sec.classTeacher), `${d}T03:40:00Z`]);
        }
      } else {
        for (const t of ttByDow.get(isoWeekday(d)) ?? []) {
          if (isToday && (periodStart.get(t.periodId) ?? '23:59') >= nowHm) continue;
          if (!isToday && d >= addDays(today, -7) && R2.chance(0.025)) continue;
          if (isToday && R2.chance(0.3)) continue;
          const sid = uuid();
          sessionRows.push([sid, I, 'subject', d, t.sectionId, t.offeringId, t.periodId, t.staffId, 'manual', 'submitted', `${d}T04:00:00Z`, `${d}T04:30:00Z`, staffUser.get(t.staffId), true]);
          for (const s of byStudentSection.get(t.sectionId) ?? []) recordRows.push([uuid(), I, sid, s.id, statusFor(s, d, R2), 'manual', staffUser.get(t.staffId), `${d}T04:10:00Z`]);
        }
      }
    }
    void nowIso;
    await bulkInsert(c, 'attendance_sessions', ['id', 'institution_id', 'kind', 'session_date', 'section_id', 'course_offering_id', 'period_id', 'taken_by_staff_id', 'method', 'status', 'started_at', 'submitted_at', 'submitted_by_user_id', 'is_demo'], sessionRows);
    await bulkInsert(c, 'attendance_records', ['id', 'institution_id', 'session_id', 'student_id', 'status', 'method', 'marked_by_user_id', 'marked_at'], recordRows);
    await bulkInsert(c, 'student_leave_requests', ['id', 'institution_id', 'student_id', 'leave_type_id', 'requested_by_user_id', 'start_date', 'end_date', 'reason', 'status', 'reviewer_user_id', 'reviewed_at'], leaveReqRows);

    // Pending leave requests (future dates) and pending correction requests from students with logins
    const withLogin = students.filter((s) => s.userId);
    const personal = leaveTypes.find((l) => l.code === 'family')!.id;
    await bulkInsert(c, 'student_leave_requests', ['id', 'institution_id', 'student_id', 'leave_type_id', 'requested_by_user_id', 'start_date', 'end_date', 'reason', 'status'],
      withLogin.slice(0, 6).map((s, i) => [uuid(), I, s.id, personal, s.guardianUserId, addDays(today, 2 + i), addDays(today, 3 + i), 'Family function out of town (demo)', 'pending']));
    const absentRecs = (await c.query<{ id: string; student_id: string }>(
      `select distinct on (r.student_id) r.id, r.student_id from attendance_records r where r.institution_id = $1 and r.status = 'absent' and r.student_id = any($2) order by r.student_id, r.marked_at desc`, [I, withLogin.map((s) => s.id)])).rows;
    await bulkInsert(c, 'attendance_correction_requests', ['id', 'institution_id', 'record_id', 'student_id', 'requested_by_user_id', 'requested_status', 'reason', 'status'],
      absentRecs.slice(0, 8).map((r) => [uuid(), I, r.id, r.student_id, withLogin.find((s) => s.id === r.student_id)!.userId, 'present', 'I attended this class but was marked absent; the attendance sheet was passed before I signed (demo).', 'pending']));

    // Announcements
    await bulkInsert(c, 'announcements', ['id', 'institution_id', 'title', 'body', 'audience', 'created_by_user_id', 'publish_at'], [
      [uuid(), I, cfg.type === 'school' ? 'Half-yearly examination schedule' : 'End-semester examination timetable', 'The examination timetable has been published. Students must maintain the required attendance to be eligible. (Demo announcement)', ['students', 'guardians', 'staff'], ownerId, `${addDays(today, -3)}T05:00:00Z`],
      [uuid(), I, 'Parent–teacher meeting', 'Parent–teacher meetings will be held on Saturday from 9:30 AM. (Demo announcement)', ['guardians', 'staff'], ownerId, `${addDays(today, -1)}T05:00:00Z`],
    ]);

    // In-app notifications for guardians of students absent in the most recent days (mirrors live behaviour).
    const recentAbs = (await c.query<{ user_id: string; first_name: string; session_date: string }>(
      `select g.user_id, s.first_name, se.session_date from attendance_records r join attendance_sessions se on se.id = r.session_id join students s on s.id = r.student_id
       join student_guardians sg on sg.student_id = s.id join guardians g on g.id = sg.guardian_id
       where r.institution_id = $1 and r.status = 'absent' and g.user_id is not null and se.session_date >= $2 limit 200`, [I, addDays(today, -5)])).rows;
    const notifRows = recentAbs.map((n) => [uuid(), I, n.user_id, 'attendance.absent', `${n.first_name} marked absent`, `${n.first_name} was marked absent on ${n.session_date}.`]);
    await bulkInsert(c, 'notifications', ['id', 'institution_id', 'recipient_user_id', 'event_key', 'title', 'body'], notifRows);

    await c.query(`insert into audit_logs (institution_id, actor_user_id, action, entity_type, entity_id, metadata) values ($1,$2,'demo.seeded','institution',$4,$3)`, [I, ownerId, JSON.stringify({ students: students.length, staff: staffList.length, sessions: sessionRows.length, records: recordRows.length }), I]);
    await c.query('commit');
    console.log(`✓ ${cfg.name}: ${students.length} students, ${staffList.length} staff, ${sections.length} sections, ${ttRows.length} timetable slots, ${sessionRows.length} sessions, ${recordRows.length} records (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  await runMigrations();
  await resetDemo();
  const demoHash = await hashPassword(DEMO_PASSWORD);
  await db.insert(users).values({ email: 'superadmin@attendiq.example', fullName: 'NEXUS Platform Admin', passwordHash: demoHash, platformRole: 'super_admin' });
  await seedInstitution(SCHOOL, demoHash);
  await seedInstitution(COLLEGE, demoHash);
  await pool.query('analyze');
  console.log(`\nDemo accounts (password: ${DEMO_PASSWORD}) — DEMO DATA ONLY:`);
  console.log('  Platform admin: superadmin@attendiq.example');
  for (const d of ['abc-school.example', 'xyz-college.example']) console.log(`  ${d}: owner@, admin@, principal@, teacher@, student@, parent@`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
