SELECT p.price * o.qty AS amount
FROM products p JOIN orders o ON p.id = o.product_id
WHERE o.status = 'paid'
