import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Value = string | number | null;

class Stmt {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    readonly args: Value[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : (a as Value))));
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes) } };
  }
  exec() {
    const s = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)/i.test(this.sql)) return { results: s.all(...this.args).map((r) => ({ ...r })), success: true, meta: {} };
    s.run(...this.args);
    return { results: [], success: true, meta: {} };
  }
}

export function testDb() {
  const db = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: async (sql: string) => db.exec(sql),
  };
  return { raw: db, d1: d1 as unknown as D1Database };
}
