import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { SchemaDef, Report } from "./types";
import { Diagnostic } from "./errors";

export interface AnalysisRow {
  id: number;
  query_id: number;
  schema_id: number;
  status: string;
  sql: string;
  schema_version: number;
  report: Report | null;
  diagnostics: Diagnostic[];
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "lineage.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schemas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        def TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_id INTEGER NOT NULL REFERENCES schemas(id),
        sql TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_id INTEGER NOT NULL REFERENCES queries(id),
        status TEXT NOT NULL,
        report TEXT,
        diagnostics TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  addSchema(def: SchemaDef): { id: number; version: number } {
    const row = this.db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM schemas").get() as any;
    const version = row.v + 1;
    const r = this.db.prepare("INSERT INTO schemas(version, def) VALUES (?, ?)").run(version, JSON.stringify(def));
    return { id: Number(r.lastInsertRowid), version };
  }

  getSchema(id: number): { id: number; version: number; def: SchemaDef } | null {
    const r = this.db.prepare("SELECT id, version, def FROM schemas WHERE id = ?").get(id) as any;
    return r ? { id: r.id, version: r.version, def: JSON.parse(r.def) } : null;
  }

  listSchemas(): any[] {
    return this.db.prepare("SELECT id, version, created_at FROM schemas ORDER BY id").all();
  }

  addQuery(schemaId: number, sql: string): number {
    const r = this.db.prepare("INSERT INTO queries(schema_id, sql) VALUES (?, ?)").run(schemaId, sql);
    return Number(r.lastInsertRowid);
  }

  getQuery(id: number): { id: number; schema_id: number; sql: string } | null {
    return (this.db.prepare("SELECT id, schema_id, sql FROM queries WHERE id = ?").get(id) as any) ?? null;
  }

  addAnalysis(queryId: number, report: Report): number {
    const r = this.db
      .prepare("INSERT INTO analyses(query_id, status, report, diagnostics) VALUES (?, ?, ?, ?)")
      .run(
        queryId,
        report.status,
        report.status === "ok" ? JSON.stringify(report) : null,
        JSON.stringify(report.diagnostics)
      );
    return Number(r.lastInsertRowid);
  }

  getAnalysis(id: number): AnalysisRow | null {
    const r = this.db
      .prepare(
        `SELECT a.id, a.query_id, a.status, a.report, a.diagnostics, a.created_at,
                q.sql, q.schema_id, s.version AS schema_version
         FROM analyses a JOIN queries q ON q.id = a.query_id JOIN schemas s ON s.id = q.schema_id
         WHERE a.id = ?`
      )
      .get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      query_id: r.query_id,
      schema_id: r.schema_id,
      schema_version: r.schema_version,
      status: r.status,
      sql: r.sql,
      report: r.report ? JSON.parse(r.report) : null,
      diagnostics: JSON.parse(r.diagnostics ?? "[]"),
      created_at: r.created_at,
    };
  }

  listAnalyses(): any[] {
    return this.db
      .prepare(
        `SELECT a.id, a.query_id, a.status, a.created_at, q.schema_id
         FROM analyses a JOIN queries q ON q.id = a.query_id ORDER BY a.id`
      )
      .all();
  }
}
