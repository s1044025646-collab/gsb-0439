import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_LIMITS, Limits, Report, SchemaDef } from './model';
import { analyze } from './analyzer';

export interface SchemaRow {
  id: number;
  version: number;
  created_at: string;
  def: SchemaDef;
}

export interface QueryRow {
  id: number;
  version: number;
  schema_id: number;
  sql: string;
  status: 'ok' | 'failed';
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'lineage.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schemas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        def TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        schema_id INTEGER NOT NULL,
        sql TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        query_id INTEGER PRIMARY KEY,
        limits TEXT NOT NULL,
        report TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 每次登记都产生一个新版本（修订表结构即新版本） */
  addSchema(def: SchemaDef): SchemaRow {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM schemas')
      .get() as { v: number };
    const now = new Date().toISOString();
    const res = this.db
      .prepare('INSERT INTO schemas(version, def, created_at) VALUES (?,?,?)')
      .run(row.v, JSON.stringify(def), now);
    return { id: Number(res.lastInsertRowid), version: row.v, created_at: now, def };
  }

  getSchema(id: number): SchemaRow | null {
    const r = this.db.prepare('SELECT * FROM schemas WHERE id=?').get(id) as
      | { id: number; version: number; def: string; created_at: string }
      | undefined;
    return r ? { id: r.id, version: r.version, created_at: r.created_at, def: JSON.parse(r.def) } : null;
  }

  listSchemas(): SchemaRow[] {
    const rows = this.db.prepare('SELECT * FROM schemas ORDER BY id').all() as Array<{
      id: number; version: number; def: string; created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, version: r.version, created_at: r.created_at, def: JSON.parse(r.def) }));
  }

  /** 提交 SQL 并立即分析；失败也保存诊断报告 */
  submitQuery(schemaId: number, sql: string, limits: Limits = DEFAULT_LIMITS): { query: QueryRow; report: Report } {
    const schema = this.getSchema(schemaId);
    if (!schema) throw Object.assign(new Error(`schema ${schemaId} 不存在`), { statusCode: 404, code: 'E_VALIDATION' });
    const report = analyze(sql, schema.def, limits);
    const vrow = this.db
      .prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM queries WHERE schema_id=?')
      .get(schemaId) as { v: number };
    const now = new Date().toISOString();
    const status = report.ok ? 'ok' : 'failed';
    const res = this.db
      .prepare('INSERT INTO queries(version, schema_id, sql, status, created_at) VALUES (?,?,?,?,?)')
      .run(vrow.v, schemaId, sql, status, now);
    const id = Number(res.lastInsertRowid);
    this.db
      .prepare('INSERT INTO reports(query_id, limits, report) VALUES (?,?,?)')
      .run(id, JSON.stringify(limits), JSON.stringify(report));
    return {
      query: { id, version: vrow.v, schema_id: schemaId, sql, status, created_at: now },
      report,
    };
  }

  getQuery(id: number): (QueryRow & { report: Report; limits: Limits }) | null {
    const q = this.db.prepare('SELECT * FROM queries WHERE id=?').get(id) as
      | { id: number; version: number; schema_id: number; sql: string; status: 'ok' | 'failed'; created_at: string }
      | undefined;
    if (!q) return null;
    const r = this.db.prepare('SELECT * FROM reports WHERE query_id=?').get(id) as
      | { limits: string; report: string }
      | undefined;
    return {
      ...q,
      limits: r ? JSON.parse(r.limits) : DEFAULT_LIMITS,
      report: r ? JSON.parse(r.report) : { ok: false, outputs: [], conditions: [], errors: [] },
    };
  }

  listQueries(): QueryRow[] {
    return this.db.prepare('SELECT * FROM queries ORDER BY id').all() as unknown as QueryRow[];
  }
}
