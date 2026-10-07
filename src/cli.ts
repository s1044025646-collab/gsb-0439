import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { Service, edgesOf } from "./service";
import { Report } from "./types";

function dataDir(): string {
  const i = process.argv.indexOf("--data-dir");
  return i >= 0 ? process.argv[i + 1] : process.env.LINEAGE_DATA_DIR ?? path.join(process.cwd(), "data");
}

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => String(r[c] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function printReport(report: Report): void {
  console.log("== 输出字段值来源 ==");
  console.log(
    table(
      report.outputs.map((f) => [
        String(f.order),
        f.name,
        f.sources.length ? f.sources.map((s) => `${s.table}.${s.column}`).join(", ") : "(常量，无来源)",
        f.pathsTruncated ? `是(>${report.limits.maxPathsPerOutput})` : "否",
      ]),
      ["#", "字段", "基础列来源", "路径截断"]
    )
  );
  console.log("\n== 条件依赖（不影响值来源） ==");
  console.log("JOIN: " + (report.conditions.join.map((s) => `${s.table}.${s.column}`).join(", ") || "(无)"));
  console.log("WHERE: " + (report.conditions.where.map((s) => `${s.table}.${s.column}`).join(", ") || "(无)"));
  console.log("\n== 来源路径 ==");
  for (const f of report.outputs) {
    for (const p of f.paths) console.log(`  ${f.name} <- ${p.steps.join(" <- ")}`);
    if (f.pathsTruncated) console.log(`  ${f.name}: ... 路径已截断，汇总来源集合完整`);
  }
}

function printErrors(service: Service, id: number): void {
  const e = service.getErrors(id);
  console.log(`analysis ${id} 状态: ${e.status}`);
  if (e.diagnostics.length === 0) {
    console.log("无错误。");
    return;
  }
  console.log(
    table(
      e.diagnostics.map((d) => [
        d.code,
        d.message,
        d.line ? `${d.line}:${d.column ?? 1}` : "-",
        (d.candidates ?? []).join(", "),
      ]),
      ["错误码", "消息", "位置(近似)", "候选"]
    )
  );
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const service = new Service(new Store(dataDir()));
  try {
    switch (cmd) {
      case "schema": {
        const file = argOf("--file");
        if (!file) throw new Error("用法: schema add --file schema.json");
        const def = JSON.parse(fs.readFileSync(file, "utf8"));
        const r = service.createSchema(def);
        console.log(`已登记 schema id=${r.id} version=${r.version}`);
        break;
      }
      case "schemas":
        console.log(table(service.store.listSchemas().map((s: any) => [String(s.id), String(s.version), s.created_at]), ["id", "version", "created_at"]));
        break;
      case "analyze": {
        const schemaId = Number(argOf("--schema"));
        const sql = argOf("--sql") ?? (argOf("--file") ? fs.readFileSync(argOf("--file")!, "utf8") : undefined);
        if (!schemaId || !sql) throw new Error("用法: analyze --schema <id> (--sql \"...\" | --file q.sql)");
        const { analysisId, report } = service.analyze({ schemaId, sql });
        console.log(`analysis id=${analysisId} 状态=${report.status}`);
        if (report.status === "ok") printReport(report);
        else printErrors(service, analysisId);
        break;
      }
      case "report": {
        const a = service.getAnalysis(Number(rest[0]));
        console.log(`analysis ${a.id} 状态=${a.status} schema版本=${a.schema_version}`);
        console.log(`SQL: ${a.sql}`);
        if (a.report) printReport(a.report);
        else printErrors(service, a.id);
        break;
      }
      case "errors":
        printErrors(service, Number(rest[0]));
        break;
      case "edges": {
        const e = service.getEdges(Number(rest[0]));
        console.log(table(e.edges.map((x) => [x.from, x.to, x.kind]), ["from(基础列)", "to", "kind"]));
        break;
      }
      case "history":
        console.log(
          table(
            service.history().map((h: any) => [String(h.id), String(h.query_id), String(h.schema_id), h.status, h.created_at]),
            ["analysis", "query", "schema", "status", "created_at"]
          )
        );
        break;
      default:
        console.log(`用法: node dist/cli.js <命令> [--data-dir DIR]
  schema add --file schema.json   登记 schema 新版本
  schemas                         列出 schema 版本
  analyze --schema ID --file q.sql / --sql "SELECT ..."
  report <analysisId>             查看字段来源报告
  errors <analysisId>             查看绑定错误与位置
  edges <analysisId>              导出边列表
  history                         分析历史`);
    }
  } finally {
    service.store.close();
  }
}

try {
  main();
} catch (e: any) {
  if (e.diagnostics) {
    for (const d of e.diagnostics) console.error(`[${d.code}] ${d.message}`);
  } else {
    console.error(String(e.message || e));
  }
  process.exit(1);
}
