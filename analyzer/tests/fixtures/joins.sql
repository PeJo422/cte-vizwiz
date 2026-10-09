WITH customers AS (
    SELECT customer_id, name, country FROM dbo.customers
),
orders AS (
    SELECT order_id, customer_id, amount, order_date FROM dbo.orders
),
enriched AS (
    SELECT
        o.order_id,
        o.amount,
        c.name AS customer_name,
        c.country,
        o.amount * 1.25 AS amount_incl_vat,
        ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.order_date DESC) AS rn
    FROM orders o
    LEFT JOIN customers c ON c.customer_id = o.customer_id
)
SELECT DISTINCT e.*, 'x' AS flag
FROM enriched e
WHERE e.rn = 1
