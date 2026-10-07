import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer";

test("CTE 内层条件依赖向上传播", () => {
  const r = analyze(
    `WITH c AS (
      SELECT p.price * o.qty AS amount FROM products p JOIN orders o ON p.id = o.product_id WHERE o.status = 'paid'
    ) SELECT amount AS total FROM c`,
    { tables: { products: ["id", "price"], orders: ["product_id", "qty", "status"] } }
  );
  assert.equal(r.status, "ok");
  assert.deepEqual(r.conditions.join.map((s) => `${s.table}.${s.column}`), ["products.id", "orders.product_id"]);
  assert.deepEqual(r.conditions.where.map((s) => `${s.table}.${s.column}`), ["orders.status"]);
  assert.deepEqual(r.outputs[0].sources.map((s) => `${s.table}.${s.column}`).sort(), ["orders.qty", "products.price"]);
});
