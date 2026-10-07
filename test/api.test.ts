import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startServer } from '../src/server';

let port = 0;
let close: () => void = () => {};
let dir = '';

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-test-'));
  const s = await startServer(0, dir);
  port = s.port;
  close = s.close;
});

after(() => close());

test('API 全流程：登记 schema、提交 SQL、查询来源、边列表、历史', async () => {
  const s = await api('POST', '/schemas', { products: ['id', 'price'], orders: ['product_id', 'qty', 'status'] });
  assert.equal(s.status, 201);
  const schemaId = s.json.id;

  const q = await api('POST', '/queries', {
    schemaId,
    sql: 'SELECT p.price * o.qty AS amount FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status <> 1',
  });
  assert.equal(q.status, 201);
  assert.equal(q.json.report.outputs[0].name, 'amount');
  assert.deepEqual(q.json.report.outputs[0].sources, ['orders.qty', 'products.price']);
  const qid = q.json.query.id;

  const f = await api('GET', `/queries/${qid}/fields/amount`);
  assert.deepEqual(f.json.sources, ['orders.qty', 'products.price']);

  const edges = await api('GET', `/queries/${qid}/edges`);
  assert.ok(edges.json.some((e: any) => e.type === 'value' && e.from === 'orders.qty' && e.to === 'amount'));
  assert.ok(edges.json.some((e: any) => e.type === 'condition' && e.from === 'orders.status'));

  const hist = await api('GET', '/queries');
  assert.ok(hist.json.some((r: any) => r.id === qid));
});

test('失败 SQL 保存诊断而不是半份成功图', async () => {
  const s = await api('POST', '/schemas', { t: ['a'] });
  const q = await api('POST', '/queries', { schemaId: s.json.id, sql: 'SELECT nope FROM t' });
  assert.equal(q.status, 422);
  assert.equal(q.json.report.ok, false);
  assert.equal(q.json.report.errors[0].code, 'E_UNKNOWN_COLUMN');
  const errs = await api('GET', `/queries/${q.json.query.id}/errors`);
  assert.equal(errs.json[0].code, 'E_UNKNOWN_COLUMN');
});

test('schema 修订后旧报告仍按旧快照解释，服务重启后仍可读取', async () => {
  const s1 = await api('POST', '/schemas', { t: ['a', 'b'] });
  const q1 = await api('POST', '/queries', { schemaId: s1.json.id, sql: 'SELECT a, b FROM t' });
  assert.equal(q1.status, 201);
  const qid = q1.json.query.id;

  // 修订 schema：删除列 b，新查询失败
  const s2 = await api('POST', '/schemas', { t: ['a'] });
  const q2 = await api('POST', '/queries', { schemaId: s2.json.id, sql: 'SELECT a, b FROM t' });
  assert.equal(q2.status, 422);

  // 重启服务（同一数据目录）
  close();
  const s = await startServer(0, dir);
  port = s.port;
  close = s.close;

  const old = await api('GET', `/queries/${qid}`);
  assert.equal(old.json.report.ok, true);
  assert.deepEqual(
    old.json.report.outputs.map((o: any) => o.name),
    ['a', 'b'],
  );
});

test('参数校验与错误码', async () => {
  const bad1 = await api('POST', '/schemas', { 'bad-name!': ['a'] });
  assert.equal(bad1.status, 400);
  assert.equal(bad1.json.code, 'E_VALIDATION');
  const bad2 = await api('POST', '/queries', { schemaId: 999, sql: 'SELECT 1 AS x FROM t' });
  assert.equal(bad2.status, 404);
  const bad3 = await api('GET', '/queries/12345');
  assert.equal(bad3.status, 404);
});
