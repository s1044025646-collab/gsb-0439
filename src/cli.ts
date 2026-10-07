#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Store } from './store';
import { startServer } from './server';
import { OutputField, Report } from './model';

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return w;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - displayWidth(c)))).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function printReport(report: Report, sql?: string): void {
  if (!report.ok) {
    console.log('分析失败:');
    for (const e of report.errors) {
      console.log(`  [${e.code}] ${e.message}`);
      if (sql && e.position >= 0) {
        console.log(`    ${sql}`);
        console.log(`    ${' '.repeat(e.position)}^`);
      }
    }
    return;
  }
  console.log('输出字段值来源:');
  printTable(
    ['字段', '基础列来源', '路径(首条)'],
    report.outputs.map((o: OutputField) => [
      o.name,
      o.sources.length ? o.sources.join(', ') : '(常量，无来源)',
      (o.paths[0] ?? '-') + (o.pathsTruncated ? ' …[已截断]' : ''),
    ]),
  );
  if (report.conditions.length > 0) {
    console.log('\n条件依赖（不参与输出字段的值来源）:');
    printTable(
      ['子句', '基础列'],
      report.conditions.map((c) => [c.clause, c.columns.join(', ')]),
    );
  }
}

const DEMO_SCHEMA = { products: ['id', 'price'], orders: ['product_id', 'qty', 'status'] };
const DEMO_SQL =
  'SELECT p.price * o.qty AS amount FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status <> 1';
const DEMO_SQL_CTE = `WITH s1 AS (
  SELECT p.price * o.qty AS amount FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status <> 1
), s2 AS (
  SELECT s1.amount AS total FROM s1
)
SELECT s2.total AS final_amount FROM s2`;

function main(): void {
  const [, , cmd, ...args] = process.argv;
  const store = new Store(dataDir);
  try {
    switch (cmd) {
      case 'serve': {
        const port = Number(argValue(args, 'port') ?? process.env.PORT ?? 0);
        startServer(port, dataDir).then(({ port: p }) =>
          console.log(`服务已启动: http://127.0.0.1:${p}`),
        );
        return; // serve 模式保持运行
      }
      case 'schema': {
        const inline = argValue(args, 'inline');
        const file = argValue(args, 'file');
        const raw = inline ?? (file ? fs.readFileSync(file, 'utf8') : undefined);
        if (!raw) throw new Error('用法: cli schema --inline \'{"t":["c"]}\' 或 --file schema.json');
        const row = store.addSchema(JSON.parse(raw));
        console.log(`已登记 schema id=${row.id} version=${row.version}`);
        break;
      }
      case 'analyze': {
        const schemaId = Number(argValue(args, 'schema'));
        const sql = argValue(args, 'sql') ?? fs.readFileSync(argValue(args, 'file')!, 'utf8');
        const { query, report } = store.submitQuery(schemaId, sql);
        console.log(`query id=${query.id} status=${query.status}`);
        printReport(report, sql);
        break;
      }
      case 'report': {
        const q = mustQuery(store, Number(args[0]));
        const field = argValue(args, 'field');
        if (field) {
          const f = q.report.outputs.find((o) => o.name === field.toLowerCase());
          if (!f) throw new Error(`输出字段 "${field}" 不存在`);
          printTable(['字段', '基础列来源'], [[f.name, f.sources.join(', ') || '(常量)']]);
          console.log('来源路径:');
          for (const p of f.paths) console.log(`  ${p}`);
          if (f.pathsTruncated) console.log('  …[路径已截断，来源集合完整]');
        } else {
          printReport(q.report, q.sql);
        }
        break;
      }
      case 'errors': {
        const q = mustQuery(store, Number(args[0]));
        printReport({ ...q.report, outputs: [], conditions: [] }, q.sql);
        break;
      }
      case 'edges': {
        const q = mustQuery(store, Number(args[0]));
        const rows: string[][] = [
          ...q.report.outputs.flatMap((o) => o.sources.map((s) => [s, o.name, 'value'])),
          ...q.report.conditions.flatMap((c, i) =>
            c.columns.map((s) => [s, `${c.clause}#${i}`, 'condition']),
          ),
        ];
        printTable(['from(基础列)', 'to', 'type'], rows);
        break;
      }
      case 'history': {
        printTable(
          ['id', 'schema', 'status', 'created_at', 'sql'],
          store.listQueries().map((q) => [
            String(q.id),
            String(q.schema_id),
            q.status,
            q.created_at,
            q.sql.length > 60 ? q.sql.slice(0, 57) + '...' : q.sql,
          ]),
        );
        break;
      }
      case 'demo': {
        const schema = store.addSchema(DEMO_SCHEMA);
        console.log(`demo schema id=${schema.id}: products(id,price), orders(product_id,qty,status)\n`);
        console.log(`SQL: ${DEMO_SQL}\n`);
        const r1 = store.submitQuery(schema.id, DEMO_SQL);
        printReport(r1.report);
        console.log(`\n两层 CTE 重命名:\n${DEMO_SQL_CTE}\n`);
        const r2 = store.submitQuery(schema.id, DEMO_SQL_CTE);
        printReport(r2.report);
        break;
      }
      default:
        console.log(`用法: node dist/src/cli.js <命令>
  serve [--port N]              启动 HTTP API（默认空闲端口）
  schema --inline JSON|--file F 登记 schema 新版本
  analyze --schema ID --sql SQL 提交并分析 SQL（或 --file）
  report <queryId> [--field F]  查看输出字段来源
  errors <queryId>              查看绑定错误及位置
  edges <queryId>               导出边列表
  history                       读取历史
  demo                          运行 products/orders 演示`);
    }
  } finally {
    if (cmd !== 'serve') store.close();
  }
}

function mustQuery(store: Store, id: number) {
  const q = store.getQuery(id);
  if (!q) throw new Error(`query ${id} 不存在`);
  return q;
}

main();
