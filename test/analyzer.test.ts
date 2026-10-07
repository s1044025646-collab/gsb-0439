import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyzer';
import { SchemaDef } from '../src/model';

const SCHEMA: SchemaDef = {
  products: ['id', 'price'],
  orders: ['product_id', 'qty', 'status'],
};

const JOIN_SQL =
  'SELECT p.price * o.qty AS amount FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status <> 1';

test('price*qty 的值来源只有 products.price 和 orders.qty，条件依赖单独列出', () => {
  const r = analyze(JOIN_SQL, SCHEMA);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.outputs.length, 1);
  assert.deepEqual(r.outputs[0].sources, ['orders.qty', 'products.price']);
  const condCols = r.conditions.flatMap((c) => c.columns).sort();
  assert.deepEqual(condCols, ['orders.product_id', 'orders.status', 'products.id']);
  // 条件列不混入值来源
  assert.ok(!r.outputs[0].sources.includes('orders.status'));
});

test('两层 CTE 重命名后仍追到相同基础列', () => {
  const sql = `WITH s1 AS (${JOIN_SQL}), s2 AS (SELECT s1.amount AS total FROM s1)
    SELECT s2.total AS final_amount FROM s2`;
  const r = analyze(sql, SCHEMA);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.outputs[0].sources, ['orders.qty', 'products.price']);
  assert.ok(r.outputs[0].paths.some((p) => p.includes('s2.total') && p.includes('orders.qty')));
});

test('常量列来源为空', () => {
  const r = analyze("SELECT 42 AS answer, 'x' AS label FROM orders o", SCHEMA);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.outputs[0].sources, []);
  assert.deepEqual(r.outputs[1].sources, []);
});

test('同名列未限定引用报歧义并列出候选', () => {
  const schema: SchemaDef = { a: ['id', 'v'], b: ['id', 'w'] };
  const r = analyze('SELECT id FROM a JOIN b ON a.id = b.id', schema);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'E_AMBIGUOUS_COLUMN');
  assert.match(r.errors[0].message, /a\.id/);
  assert.match(r.errors[0].message, /b\.id/);
});

test('别名遮蔽：限定名绑定到别名而非原表名', () => {
  // products 被赋予别名 orders，orders.price 应解析到 products.price
  const r = analyze('SELECT orders.price AS p FROM products orders', SCHEMA);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.outputs[0].sources, ['products.price']);
});

test('星号按来源表顺序及登记列顺序展开，别名星号只展开对应来源', () => {
  const r = analyze('SELECT * FROM products p JOIN orders o ON p.id = o.product_id', SCHEMA);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(
    r.outputs.map((o) => o.name),
    ['id', 'price', 'product_id', 'qty', 'status'],
  );
  const r2 = analyze('SELECT p.* FROM products p JOIN orders o ON p.id = o.product_id', SCHEMA);
  assert.deepEqual(r2.outputs.map((o) => o.name), ['id', 'price']);
});

test('CTE 的星号使用其已解析输出结构', () => {
  const sql = 'WITH s AS (SELECT o.qty AS q2, o.status FROM orders o) SELECT s.* FROM s';
  const r = analyze(sql, SCHEMA);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.outputs.map((o) => o.name), ['q2', 'status']);
  assert.deepEqual(r.outputs[0].sources, ['orders.qty']);
});

test('多个表达式重复引用同一列不会重复计来源', () => {
  const r = analyze(
    'SELECT o.qty + o.qty AS doubled, o.qty * 2 AS twice FROM orders o',
    SCHEMA,
  );
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.outputs[0].sources, ['orders.qty']);
  assert.deepEqual(r.outputs[1].sources, ['orders.qty']);
});

test('标量函数结果的来源是参数来源的集合', () => {
  const r = analyze('SELECT upper(o.status) AS s, abs(o.qty) + p.price AS v FROM orders o JOIN products p ON p.id = o.product_id', SCHEMA);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.outputs[0].sources, ['orders.status']);
  assert.deepEqual(r.outputs[1].sources, ['orders.qty', 'products.price']);
});

test('未知表、未知列明确报错', () => {
  const r1 = analyze('SELECT x.a FROM missing x', SCHEMA);
  assert.equal(r1.errors[0].code, 'E_UNKNOWN_TABLE');
  const r2 = analyze('SELECT o.nope FROM orders o', SCHEMA);
  assert.equal(r2.errors[0].code, 'E_UNKNOWN_COLUMN');
});

test('不支持的语法明确拒绝', () => {
  const cases: Array<[string, string]> = [
    ['SELECT count(*) AS c FROM orders o', 'E_UNSUPPORTED'],
    ['SELECT o.qty FROM orders o GROUP BY o.qty', 'E_UNSUPPORTED'],
    ['SELECT a FROM t1 UNION SELECT a FROM t2', 'E_UNSUPPORTED'],
    ['SELECT (SELECT o.qty FROM orders o) AS x FROM products p', 'E_UNSUPPORTED'],
    ['SELECT o.qty, row_number() OVER () AS rn FROM orders o', 'E_UNSUPPORTED'],
    ['SELECT * FROM (SELECT o.qty FROM orders o) s', 'E_UNSUPPORTED'],
  ];
  for (const [sql, code] of cases) {
    const r = analyze(sql, { ...SCHEMA, t1: ['a'] });
    assert.equal(r.ok, false, sql);
    assert.equal(r.errors[0].code, code, sql);
  }
});

test('CTE 前向引用与自引用报错', () => {
  const fwd = analyze('WITH a AS (SELECT b.x FROM b), b AS (SELECT o.qty AS x FROM orders o) SELECT a.x FROM a', SCHEMA);
  assert.equal(fwd.errors[0].code, 'E_CTE_FORWARD');
  const cyc = analyze('WITH a AS (SELECT a.x FROM a) SELECT a.x FROM a', SCHEMA);
  assert.equal(cyc.errors[0].code, 'E_CTE_CYCLE');
});

test('重复输出名报错', () => {
  const r = analyze('SELECT o.qty AS x, o.status AS x FROM orders o', SCHEMA);
  assert.equal(r.errors[0].code, 'E_DUP_OUTPUT');
});

test('表达式缺别名报错', () => {
  const r = analyze('SELECT o.qty * 2 FROM orders o', SCHEMA);
  assert.equal(r.errors[0].code, 'E_EXPR_NEEDS_ALIAS');
});

test('空白、大小写、无关别名变化不改变语义', () => {
  const base = analyze(JOIN_SQL, SCHEMA);
  const variant = analyze(
    '  SELECT P.Price*O.Qty   AS AMOUNT\nFROM ORDERS O LEFT JOIN PRODUCTS P ON P.ID=O.Product_Id WHERE O.Status<>1',
    { PRODUCTS: ['ID', 'PRICE'], ORDERS: ['PRODUCT_ID', 'QTY', 'STATUS'] } as unknown as SchemaDef,
  );
  assert.ok(variant.ok, JSON.stringify(variant.errors));
  assert.deepEqual(variant.outputs, base.outputs);
  assert.deepEqual(variant.conditions, base.conditions);
});

test('限制：超长 SQL 与过多 CTE 被拒绝', () => {
  const long = analyze('SELECT o.qty FROM orders o'.padEnd(30000, ' '), SCHEMA);
  assert.equal(long.errors[0].code, 'E_LIMIT');
  const manyCtes = `WITH ${Array.from({ length: 20 }, (_, i) => `c${i} AS (SELECT o.qty AS x FROM orders o)`).join(',')} SELECT c0.x FROM c0`;
  const r = analyze(manyCtes, SCHEMA);
  assert.equal(r.errors[0].code, 'E_LIMIT');
});
