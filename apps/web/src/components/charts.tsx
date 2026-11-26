import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtDate } from '../lib/format';

const INK = '#475569'; const GRID = '#e2e8f0'; const BRAND = '#2747c4';
const tip = { contentStyle: { borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }, labelStyle: { color: '#0f172a', fontWeight: 600 } };

/** Single-series attendance trend with the eligibility threshold as a reference line. */
export function TrendChart({ data, threshold }: { data: { date: string; percentage: number | null; conducted: number }[]; threshold?: number }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={BRAND} stopOpacity={0.18} /><stop offset="100%" stopColor={BRAND} stopOpacity={0} /></linearGradient></defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} tick={{ fontSize: 11, fill: INK }} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis domain={[(min: number) => Math.max(0, Math.floor(min / 10) * 10 - 10), 100]} tick={{ fontSize: 11, fill: INK }} axisLine={false} tickLine={false} unit="%" />
        <Tooltip {...tip} labelFormatter={(d) => fmtDate(String(d))} formatter={(v: number, _n, p) => [`${v}% (${p.payload.conducted} marks)`, 'Attendance']} />
        {threshold !== undefined && <ReferenceLine y={threshold} stroke="#b91c1c" strokeDasharray="4 4" label={{ value: `${threshold}% threshold`, fill: '#b91c1c', fontSize: 11, position: 'insideBottomRight' }} />}
        <Area type="monotone" dataKey="percentage" stroke={BRAND} strokeWidth={2} fill="url(#g)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars of attendance % per group (one hue; threshold reference). */
export function GroupBars({ data, threshold, height }: { data: { label: string; percentage: number | null }[]; threshold?: number; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(160, data.length * 26 + 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barCategoryGap={4}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: INK }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="label" width={120} tick={{ fontSize: 11, fill: INK }} axisLine={false} tickLine={false} />
        <Tooltip {...tip} cursor={{ fill: '#f1f5f9' }} formatter={(v: number) => [`${v}%`, 'Attendance']} />
        {threshold !== undefined && <ReferenceLine x={threshold} stroke="#b91c1c" strokeDasharray="4 4" />}
        <Bar dataKey="percentage" fill={BRAND} radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
