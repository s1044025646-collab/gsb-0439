import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { createServer, findFreePort } from "../src/server";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lineage-"));
}

const schemaBody = { tables: { products: ["id", "price"], orders: ["product_id", "qty", "status"] } };
const SQL = `SELECT p.price * o.qty AS amount FROM products p JOIN orders o ON p.id = o.product_id WHERE o.status = 'paid'`;

test("服务流程: 登记 schema -> 分析 -> 报告/边/历史 -> 重启后可读", async () => {
  const dir = tmpDir();
  let service = new Service(new Store(dir));
  const s = service.createSchema(schemaBody);
  assert.equal(s.version, 1);
  const { analysisId, report } = service.analyze({ schemaId: s.id, sql: SQL });
  assert.equal(report.status, "ok");
  const amount = report.outputs[0];
  assert.deepEqual(amount.sources.map((x) => `${x.table}.${x.column}`).sort(), ["orders.qty", "products.price"]);

  const edges = service.getEdges(analysisId);
  assert.ok(edges.edges.some((e) => e.kind === "join" && e.from === "products.id"));
  assert.ok(edges.edges.some((e) => e.kind === "where" && e.from === "orders.status"));
  assert.ok(!edges.edges.some((e) => e.kind === "value" && e.from === "orders.status"));

  // 修改 schema 使旧查询失效 -> 新分析失败，旧报告仍按旧快照可读
  const s2 = service.createSchema({ tables: { products: ["id"], orders: ["product_id", "qty", "status"] } });
  const failed = service.analyze({ schemaId: s2.id, sql: SQL });
  assert.equal(failed.report.status, "failed");
  assert.equal(failed.report.diagnostics[0].code, "E_UNKNOWN_COLUMN");
  service.store.close();

  // 模拟重启
  service = new Service(new Store(dir));
  const old = service.getAnalysis(analysisId);
  assert.equal(old.status, "ok");
  assert.equal(old.schema_version, 1);
  assert.equal(old.report!.outputs[0].name, "amount");
  const errs = service.getErrors(failed.analysisId);
  assert.equal(errs.status, "failed");
  assert.ok(errs.diagnostics.length > 0);
  assert.ok(service.history().length >= 2);
  assert.throws(() => service.getEdges(failed.analysisId));
  service.store.close();
});

test("HTTP API 端到端", async () => {
  const dir = tmpDir();
  const service = new Service(new Store(dir));
  const server = createServer(service);
  const port = await findFreePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown) =>
    (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const get = async (p: string) => (await fetch(base + p));

  let res = await post("/schemas", schemaBody);
  assert.equal(res.status, 201);
  const { id: schemaId } = (await res.json()) as any;

  res = await post("/analyze", { schemaId, sql: SQL });
  assert.equal(res.status, 200);
  const { analysisId, report } = (await res.json()) as any;
  assert.equal(report.status, "ok");

  res = await get(`/analyses/${analysisId}`);
  assert.equal(res.status, 200);
  res = await get(`/analyses/${analysisId}/edges`);
  const edges = (await res.json()) as any;
  assert.ok(edges.edges.length > 0);
  res = await get("/analyses");
  assert.ok(((await res.json()) as any[]).length >= 1);

  // 失败路径：坏 SQL 返回诊断
  res = await post("/analyze", { schemaId, sql: "SELECT sum(x) AS s FROM products" });
  const bad = (await res.json()) as any;
  assert.equal(bad.report.status, "failed");
  res = await get(`/analyses/${bad.analysisId}/errors`);
  const errs = (await res.json()) as any;
  assert.equal(errs.diagnostics[0].code, "E_UNSUPPORTED");

  // 参数校验
  res = await post("/analyze", { sql: 123 });
  assert.equal(res.status, 400);
  res = await get("/analyses/9999");
  assert.equal(res.status, 400);

  server.close();
  service.store.close();
});
