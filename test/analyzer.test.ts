import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer";
import { SchemaDef } from "../src/types";

const schema: SchemaDef = {
  tables: {
    products: ["id", "price"],
    orders: ["product_id", "qty", "status"],
  },
};

function ok(sql: string, s: SchemaDef = schema) {
  const r = analyze(sql, s);
  assert.equal(r.status, "ok", JSON.stringify(r.diagnostics));
  return r;
}

function bad(sql: string, s: SchemaDef = schema) {
  const r = analyze(sql, s);
  assert.equal(r.status, "failed", sql);
  return r.diagnostics[0];
}

const srcs = (r: any, name: string) =>
  r.outputs.find((f: any) => f.name === name).sources.map((s: any) => `${s.table}.${s.column}`).sort();

test("演示: price*qty AS amount 值来源仅 products.price 与 orders.qty", () => {
  const r = ok(`SELECT p.id, o.qty, p.price * o.qty AS amount
    FROM products p JOIN orders o ON p.id = o.product_id
    WHERE o.status = 'paid'`);
  assert.deepEqual(srcs(r, "amount"), ["orders.qty", "products.price"]);
  assert.deepEqual(srcs(r, "id"), ["products.id"]);
  // 连接键与 status 只在条件依赖中
  assert.deepEqual(r.conditions.join.map((s: any) => `${s.table}.${s.column}`), ["products.id", "orders.product_id"]);
  assert.deepEqual(r.conditions.where.map((s: any) => `${s.table}.${s.column}`), ["orders.status"]);
  assert.ok(!srcs(r, "amount").includes("orders.status"));
});

test("两层 CTE 重命名仍追到相同基础列", () => {
  const r = ok(`WITH c1 AS (
      SELECT p.price * o.qty AS amount FROM products p JOIN orders o ON p.id = o.product_id
    ), c2 AS (
      SELECT amount AS total FROM c1
    )
    SELECT total AS final_amount FROM c2`);
  assert.deepEqual(srcs(r, "final_amount"), ["orders.qty", "products.price"]);
  const f = r.outputs[0];
  assert.ok(f.paths[0].steps.join(" ").includes("cte c2.total"));
  assert.ok(f.paths[0].steps.join(" ").includes("cte c1.amount"));
});

test("常量列值来源为空", () => {
  const r = ok("SELECT 1 AS one, 'x' AS label, p.price FROM products p");
  assert.deepEqual(srcs(r, "one"), []);
  assert.deepEqual(srcs(r, "label"), []);
});

test("同名列歧义报告候选表", () => {
  const s2: SchemaDef = { tables: { a: ["id", "x"], b: ["id", "y"] } };
  const d2 = bad("SELECT id FROM a JOIN b ON a.id = b.id", s2);
  assert.equal(d2.code, "E_AMBIGUOUS_COLUMN");
  assert.deepEqual(d2.candidates?.sort(), ["a", "b"]);
});

test("限定列必须走别名；别名遮蔽原表名", () => {
  const r = ok("SELECT p.price FROM products p");
  assert.deepEqual(srcs(r, "price"), ["products.price"]);
  const d = bad("SELECT products.price FROM products p");
  assert.equal(d.code, "E_UNKNOWN_TABLE");
});

test("星号按来源顺序与登记列顺序展开", () => {
  const r = ok(`SELECT p.*, o.* FROM products p LEFT JOIN orders o ON p.id = o.product_id`);
  assert.deepEqual(r.outputs.map((f: any) => f.name), ["id", "price", "product_id", "qty", "status"]);
  assert.deepEqual(srcs(r, "qty"), ["orders.qty"]);
});

test("CTE 星号使用已解析输出结构", () => {
  const r = ok(`WITH c AS (SELECT p.price AS pr, 5 AS k FROM products p) SELECT c.* FROM c`);
  assert.deepEqual(r.outputs.map((f: any) => f.name), ["pr", "k"]);
  assert.deepEqual(srcs(r, "pr"), ["products.price"]);
  assert.deepEqual(srcs(r, "k"), []);
});

test("多个表达式重复引用同一列不重复计来源", () => {
  const r = ok("SELECT p.price + p.price AS dbl, p.price * p.price * p.price AS cube FROM products p");
  assert.deepEqual(srcs(r, "dbl"), ["products.price"]);
  assert.deepEqual(srcs(r, "cube"), ["products.price"]);
  const cube = r.outputs.find((f: any) => f.name === "cube");
  assert.equal(cube.paths.length, 1);
});

test("标量函数来源为参数集合", () => {
  const r = ok("SELECT upper(o.status) AS s, abs(o.qty) + p.price AS v FROM products p JOIN orders o ON p.id = o.product_id");
  assert.deepEqual(srcs(r, "s"), ["orders.status"]);
  assert.deepEqual(srcs(r, "v"), ["orders.qty", "products.price"]);
});

test("未知表 / 未知列", () => {
  assert.equal(bad("SELECT x FROM nope").code, "E_UNKNOWN_TABLE");
  assert.equal(bad("SELECT p.nope FROM products p").code, "E_UNKNOWN_COLUMN");
});

test("不支持语法明确拒绝", () => {
  assert.equal(bad("SELECT sum(p.price) AS s FROM products p").code, "E_UNSUPPORTED");
  assert.equal(bad("SELECT p.price FROM products p GROUP BY p.price").code, "E_UNSUPPORTED");
  assert.equal(bad("SELECT p.price FROM products p UNION SELECT o.qty FROM orders o").code, "E_UNSUPPORTED");
  assert.equal(bad("SELECT x.v FROM (SELECT p.price AS v FROM products p) x").code, "E_UNSUPPORTED");
  assert.equal(bad("SELECT row_number() OVER () AS r FROM products p").code, "E_UNSUPPORTED");
  assert.equal(bad("SELECT p.price FROM products p WHERE p.id IN (SELECT o.product_id FROM orders o)").code, "E_UNSUPPORTED");
});

test("CTE 前向与循环引用", () => {
  assert.equal(bad("WITH a AS (SELECT x.v FROM b x), b AS (SELECT p.price AS v FROM products p) SELECT a.v FROM a").code, "E_CTE_FORWARD");
  assert.equal(bad("WITH a AS (SELECT a.v FROM a) SELECT 1 AS k FROM products p").code, "E_CTE_CYCLE");
});

test("重复输出名与缺别名", () => {
  assert.equal(bad("SELECT p.price AS v, p.id AS v FROM products p").code, "E_DUP_OUTPUT");
  assert.equal(bad("SELECT p.price + 1 FROM products p").code, "E_MISSING_ALIAS");
});

test("大小写与空白不改变语义", () => {
  const a = ok("SELECT p.price*o.qty AS amount FROM products p JOIN orders o ON p.id=o.product_id");
  const b = ok("  SELECT  P.PRICE * O.Qty  AS AMOUNT\nFROM PRODUCTS P\nJOIN ORDERS O ON P.ID = O.PRODUCT_ID ");
  assert.deepEqual(srcs(a, "amount"), srcs(b, "amount"));
  assert.equal(b.outputs[0].name, "amount");
});

test("无关别名变化不改变来源", () => {
  const a = ok("SELECT p.price * o.qty AS amount FROM products p JOIN orders o ON p.id = o.product_id");
  const b = ok("SELECT x.price * y.qty AS amount FROM products x JOIN orders y ON x.id = y.product_id");
  assert.deepEqual(srcs(a, "amount"), srcs(b, "amount"));
});
