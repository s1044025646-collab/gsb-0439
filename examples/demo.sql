WITH c1 AS (
  SELECT p.id AS pid, p.price * o.qty AS amount
  FROM products p JOIN orders o ON p.id = o.product_id
  WHERE o.status = 'paid'
),
c2 AS (
  SELECT pid, amount AS total FROM c1
)
SELECT pid, total AS final_amount, 42 AS const_col FROM c2
