WITH orders AS (
    SELECT order_id, customer_id, amount
    FROM raw_orders
),
filtered_orders AS (
    SELECT *
    FROM orders
    WHERE amount > 100
),
customer_totals AS (
    SELECT
        customer_id,
        SUM(amount) AS total_amount
    FROM filtered_orders
    GROUP BY customer_id
)
SELECT *
FROM customer_totals;