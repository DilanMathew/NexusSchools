import type pg from 'pg';

/** Deterministic PRNG so demo data is reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  function pick<T>(arr: readonly T[]): T { return arr[Math.floor(next() * arr.length)]; }
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick,
    chance: (p: number) => next() < p,
  };
}

/** Multi-row INSERT in chunks (keeps under PostgreSQL's 65535 parameter limit). */
export async function bulkInsert(client: pg.PoolClient | pg.Pool, table: string, cols: string[], rows: unknown[][]) {
  if (!rows.length) return;
  const per = Math.floor(60000 / cols.length);
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`).join(',');
    await client.query(`insert into ${table} (${cols.join(',')}) values ${values}`, params);
  }
}

export const FIRST = ['Aarav', 'Aditi', 'Akash', 'Ananya', 'Arjun', 'Bhavya', 'Charan', 'Deepika', 'Dhruv', 'Divya', 'Gautam', 'Harini', 'Ishaan', 'Janani', 'Karthik', 'Kavya', 'Lakshmi', 'Madhan', 'Meera', 'Mohan', 'Nandini', 'Naveen', 'Nithya', 'Pooja', 'Pranav', 'Priya', 'Rahul', 'Ramya', 'Rohit', 'Sanjana', 'Saravanan', 'Shreya', 'Siddharth', 'Sneha', 'Surya', 'Swathi', 'Tarun', 'Uma', 'Varun', 'Vidya', 'Vignesh', 'Yamini', 'Abdul', 'Fathima', 'John', 'Mary', 'Joseph', 'Grace', 'Arul', 'Selvi', 'Ravi', 'Keerthana', 'Hari', 'Anitha', 'Manoj', 'Revathi'];
export const LAST = ['Kumar', 'Sharma', 'Iyer', 'Nair', 'Reddy', 'Pillai', 'Raj', 'Krishnan', 'Subramanian', 'Menon', 'Rao', 'Patel', 'Singh', 'Joseph', 'Thomas', 'Murugan', 'Ganesan', 'Natarajan', 'Bose', 'Das', 'Fernandes', 'Khan', 'Varghese', 'Shankar', 'Balaji', 'Selvam', 'Arumugam', 'Chandran'];
