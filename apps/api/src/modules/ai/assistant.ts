import Anthropic from '@anthropic-ai/sdk';
import { and, count, eq, gte, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { aiUsageLogs, institutions, institutionSubscriptions, subscriptionPlans } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { todayIn } from '../../lib/dates.js';
import type { TenantContext } from '../../types.js';
import { TOOLS, toolByName } from './tools.js';

export interface AssistantAnswer { answer: string; toolCalls: { tool: string; input: unknown; rows: number }[]; mode: 'llm' | 'builtin' }

export const llmConfigured = () => env.AI_PROVIDER === 'anthropic' && !!env.ANTHROPIC_API_KEY;
let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 }));

async function runTool(ctx: TenantContext, name: string, raw: unknown) {
  const t = toolByName(name);
  if (!t) return { error: `Unknown tool ${name}` };
  const parsed = t.input.safeParse(raw);
  if (!parsed.success) return { error: 'Invalid tool input', issues: parsed.error.issues.map((i) => i.message) };
  try { return await (t.run as (c: TenantContext, i: unknown) => Promise<unknown>)(ctx, parsed.data); }
  catch (e) { return { error: e instanceof AppError ? e.message : 'Tool failed' }; }
}

/** Monthly LLM request cap from the institution's plan (never hardcoded). */
async function assertWithinPlan(institutionId: string) {
  const [sub] = await db.select({ limits: subscriptionPlans.limits }).from(institutionSubscriptions).innerJoin(subscriptionPlans, eq(subscriptionPlans.id, institutionSubscriptions.planId))
    .where(eq(institutionSubscriptions.institutionId, institutionId)).orderBy(desc(institutionSubscriptions.createdAt)).limit(1);
  const cap = sub?.limits.aiRequestsPerMonth ?? 0;
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [{ n }] = await db.select({ n: count() }).from(aiUsageLogs).where(and(eq(aiUsageLogs.institutionId, institutionId), eq(aiUsageLogs.provider, 'anthropic'), gte(aiUsageLogs.createdAt, monthStart)));
  if (n >= cap) throw new AppError(429, 'AI_LIMIT', cap === 0 ? 'Your plan does not include the AI assistant.' : `Your plan's AI assistant limit (${cap} requests this month) has been reached.`);
}

const SYSTEM = (instName: string, today: string) => `You are the attendance assistant inside NEXUS AttendIQ for ${instName}. Today is ${today}.
Answer administrative questions about attendance using only the data tools provided. Every figure in your answer must come from a tool result in this conversation; if the tools cannot answer, say so and suggest which report page to use.
The tools already restrict data to what this user may see. Do not speculate about students' health, family, finances or other personal circumstances, and do not recommend penalties; you may suggest follow-up by a class teacher.
Keep answers short: a one-line headline, then at most 10 bullet rows (name, class, figure), then one line saying how many more there are if the list was cut. Use plain text, no tables or headings.`;

export async function askLlm(ctx: TenantContext, userId: string, question: string): Promise<AssistantAnswer> {
  await assertWithinPlan(ctx.institutionId);
  const [inst] = await db.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, ctx.institutionId));
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.jsonSchema as Anthropic.Beta.BetaTool.InputSchema, strict: true }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: question }];
  const calls: AssistantAnswer['toolCalls'] = [];
  let inTok = 0; let outTok = 0;
  try {
    for (let turn = 0; turn < 6; turn++) {
      const res = await getClient().beta.messages.create({
        model: env.AI_MODEL, max_tokens: 16000, system: SYSTEM(inst.name, todayIn(ctx.timezone)), tools, messages,
        output_config: { effort: env.AI_EFFORT },
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      });
      inTok += res.usage.input_tokens; outTok += res.usage.output_tokens;
      if (res.stop_reason === 'refusal') throw new AppError(422, 'AI_REFUSED', 'The assistant could not answer that question. Try rephrasing it, or use the Reports page.');
      if (res.stop_reason !== 'tool_use') {
        const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
        await logUsage(ctx, userId, 'ok', inTok, outTok, calls);
        return { answer: text || 'No answer was produced.', toolCalls: calls, mode: 'llm' };
      }
      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue;
        const out = await runTool(ctx, b.name, b.input) as { rows?: unknown[]; error?: string };
        calls.push({ tool: b.name, input: b.input, rows: out.rows?.length ?? 0 });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out), is_error: !!out.error });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new AppError(504, 'AI_TOO_MANY_STEPS', 'The question needed too many steps. Try asking something more specific.');
  } catch (e) {
    await logUsage(ctx, userId, 'error', inTok, outTok, calls, e instanceof Error ? e.message : String(e));
    if (e instanceof AppError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new AppError(429, 'AI_BUSY', 'The AI service is busy. Try again in a minute.');
    if (e instanceof Anthropic.APIError) throw new AppError(502, 'AI_UNAVAILABLE', 'The AI service is unavailable right now. Attendance features are unaffected.');
    throw e;
  }
}

async function logUsage(ctx: TenantContext, userId: string, status: string, input: number, output: number, toolCalls: unknown, error?: string) {
  await db.insert(aiUsageLogs).values({ institutionId: ctx.institutionId, userId, agent: 'institutional_assistant', provider: 'anthropic', model: env.AI_MODEL, inputTokens: input, outputTokens: output, toolCalls, status, error: error?.slice(0, 500) ?? null });
}

/** No-LLM mode: recognises common questions and answers from the same tools with templated text. */
export async function askBuiltin(ctx: TenantContext, userId: string, question: string): Promise<AssistantAnswer> {
  const q = question.toLowerCase();
  const num = (re: RegExp) => { const m = q.match(re); return m ? Number(m[1]) : null; };
  let name: string; let input: Record<string, unknown>;
  if (/consecutive|in a row|continuous/.test(q)) { name = 'consecutive_absences'; input = { minDays: Math.max(2, num(/(\d+)\s*(?:or more\s*)?(?:consecutive|days)/) ?? (/three/.test(q) ? 3 : /two/.test(q) ? 2 : 3)) }; }
  else if (/(not|n't|haven.t|pending|missing).*(submit|attendance)|submission/.test(q)) { name = 'pending_attendance_submissions'; input = { from: null, to: null }; }
  else if (/absent/.test(q)) { name = 'absent_students_on_date'; input = { date: /yesterday/.test(q) ? addDaysLocal(todayIn(ctx.timezone), -1) : null }; }
  else if (/department|section|class(es)? (?:with|has)|lowest|highest|compare/.test(q)) { name = 'attendance_by_group'; input = { groupBy: /department/.test(q) ? 'department' : 'section', from: null, to: null }; }
  else if (/below|under|less than|shortage|at risk|low attendance/.test(q)) {
    const cls = question.match(/(grade\s*\d+\s*[a-z]?|(?:cse|ece|mech|civil)\s*year\s*[iv]+\s*[a-z]?)/i)?.[1] ?? null;
    name = 'students_below_threshold'; input = { threshold: num(/(\d{1,3})\s*%/) ?? num(/below\s*(\d{1,3})/), classLabel: cls, from: null, to: null };
  } else {
    return { mode: 'builtin', toolCalls: [], answer: 'I can answer: students below a percentage, absent students today, attendance by department or section, pending attendance submissions, and consecutive absences. The full AI assistant needs an AI provider to be configured.' };
  }
  const out = await runTool(ctx, name, input) as { rows?: Record<string, unknown>[]; summary?: Record<string, unknown>; error?: string };
  await db.insert(aiUsageLogs).values({ institutionId: ctx.institutionId, userId, agent: 'institutional_assistant', provider: 'builtin', toolCalls: [{ name, input }], status: out.error ? 'error' : 'ok' });
  if (out.error) return { mode: 'builtin', toolCalls: [{ tool: name, input, rows: 0 }], answer: out.error };
  const rows = out.rows ?? []; const s = out.summary ?? {};
  const list = (fmt: (r: Record<string, unknown>) => string) => rows.slice(0, 10).map((r) => `• ${fmt(r)}`).join('\n') + (rows.length > 10 ? `\n…and ${rows.length - 10} more (see Reports).` : '');
  let answer = '';
  if (name === 'students_below_threshold') answer = rows.length ? `${s.totalMatching} student(s) are below ${s.threshold}% (${s.from} to ${s.to}):\n${list((r) => `${r.name} (${r.classLabel}) — ${r.percentage}%, ${r.attended}/${r.counted}`)}` : `No students are below ${s.threshold}% for ${s.from} to ${s.to}.`;
  if (name === 'absent_students_on_date') answer = rows.length ? `${s.fullDayAbsent} student(s) were absent all day and ${s.partlyAbsent} partly on ${s.date}:\n${list((r) => `${r.name} (${r.classLabel}) — ${r.fullDay ? 'full day' : `${r.absentSessions} of ${r.sessions} sessions`}`)}` : `No absences recorded for ${s.date} (${s.studentsMarked} students marked so far).`;
  if (name === 'attendance_by_group') answer = rows.length ? `Attendance by ${s.groupBy}, ${s.from} to ${s.to}, lowest first:\n${list((r) => `${r.group} — ${r.percentage}%`)}` : 'No submitted attendance in this period.';
  if (name === 'pending_attendance_submissions') answer = rows.length ? `${s.pending} scheduled register(s) not yet submitted (${s.from}${s.to !== s.from ? ` to ${s.to}` : ''}):\n${list((r) => `${r.faculty} — ${r.pending} pending`)}` : `All ${s.expected} expected registers are submitted.`;
  if (name === 'consecutive_absences') answer = rows.length ? `${s.matching} student(s) absent ${s.minDays}+ consecutive days:\n${list((r) => `${r.name} (${r.classLabel}) — ${r.consecutiveDays} days`)}` : `No students are currently absent ${s.minDays}+ days in a row.`;
  return { mode: 'builtin', toolCalls: [{ tool: name, input, rows: rows.length }], answer };
}

function addDaysLocal(d: string, n: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
