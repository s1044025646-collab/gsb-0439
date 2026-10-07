import { Store } from "./store";
import { validateSchema } from "./schema";
import { analyze } from "./analyzer";
import { AnalysisError, Diagnostic } from "./errors";
import { Report } from "./types";

export interface Edge {
  from: string; // base table.column
  to: string;   // output field 或条件占位
  kind: "value" | "join" | "where";
}

export function edgesOf(report: Report): Edge[] {
  const edges: Edge[] = [];
  for (const f of report.outputs)
    for (const s of f.sources)
      edges.push({ from: `${s.table}.${s.column}`, to: f.name, kind: "value" });
  for (const s of report.conditions.join)
    edges.push({ from: `${s.table}.${s.column}`, to: "(join-condition)", kind: "join" });
  for (const s of report.conditions.where)
    edges.push({ from: `${s.table}.${s.column}`, to: "(where-condition)", kind: "where" });
  return edges;
}

function raise(code: Diagnostic["code"], message: string): never {
  throw new AnalysisError([{ code, message }]);
}

export class Service {
  constructor(public store: Store) {}

  createSchema(body: unknown) {
    const def = validateSchema(body);
    return this.store.addSchema(def);
  }

  submitQuery(body: any) {
    if (!body || typeof body.sql !== "string")
      raise("E_VALIDATION", "需要 { schemaId, sql }");
    const schemaId = Number(body.schemaId);
    if (!Number.isInteger(schemaId)) raise("E_VALIDATION", "schemaId 必须是整数");
    if (!this.store.getSchema(schemaId)) raise("E_NOT_FOUND", `schema ${schemaId} 不存在`);
    const id = this.store.addQuery(schemaId, body.sql);
    return { queryId: id };
  }

  analyze(body: any): { analysisId: number; report: Report } {
    let queryId: number;
    if (body && body.queryId !== undefined) {
      queryId = Number(body.queryId);
      if (!Number.isInteger(queryId)) raise("E_VALIDATION", "queryId 必须是整数");
      if (!this.store.getQuery(queryId)) raise("E_NOT_FOUND", `query ${queryId} 不存在`);
    } else if (body && typeof body.sql === "string") {
      queryId = this.submitQuery(body).queryId;
    } else {
      raise("E_VALIDATION", "需要 { queryId } 或 { schemaId, sql }");
    }
    const q = this.store.getQuery(queryId)!;
    const schema = this.store.getSchema(q.schema_id)!;
    const report = analyze(q.sql, schema.def);
    const id = this.store.addAnalysis(queryId, report);
    return { analysisId: id, report };
  }

  getAnalysis(id: number) {
    const a = this.store.getAnalysis(id);
    if (!a) raise("E_NOT_FOUND", `analysis ${id} 不存在`);
    return a;
  }

  getErrors(id: number) {
    const a = this.getAnalysis(id);
    return { analysisId: id, status: a.status, diagnostics: a.diagnostics };
  }

  getEdges(id: number) {
    const a = this.getAnalysis(id);
    if (a.status !== "ok" || !a.report)
      raise("E_VALIDATION", `analysis ${id} 分析失败，无边列表可导出（见 diagnostics）`);
    return { analysisId: id, edges: edgesOf(a.report) };
  }

  history() {
    return this.store.listAnalyses();
  }
}
