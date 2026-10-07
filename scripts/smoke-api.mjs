// API 冒烟脚本：启动服务 -> 登记 schema -> 提交 SQL -> 读报告/边 -> 关闭
import { startServer } from '../dist/src/server.js';

const { port, close } = await startServer(0, 'data');
const base = `http://127.0.0.1:${port}`;
const post = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json());

const schema = await post('/schemas', { products: ['id', 'price'], orders: ['product_id', 'qty', 'status'] });
console.log('schema:', schema.id, 'v' + schema.version);
const q = await post('/queries', {
  schemaId: schema.id,
  sql: 'SELECT p.price*o.qty AS amount FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.status<>1',
});
console.log('query:', q.query.id, q.query.status);
console.log('amount sources:', JSON.stringify(q.report.outputs[0].sources));
const edges = await fetch(`${base}/queries/${q.query.id}/edges`).then((r) => r.json());
console.log('edges:', JSON.stringify(edges));
const bad = await post('/queries', { schemaId: schema.id, sql: 'SELECT count(*) AS c FROM orders o' });
console.log('unsupported rejected:', bad.report.errors[0].code, '-', bad.report.errors[0].message);
close();
