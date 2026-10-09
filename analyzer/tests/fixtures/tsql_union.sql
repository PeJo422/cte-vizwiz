;WITH [Sales 2023] AS (
    SELECT TOP 10 [Order Id], [Amount] FROM sales.[Orders2023] ORDER BY [Amount] DESC
),
sales_2024 (id, amt) AS (
    SELECT order_id, amount FROM sales.orders_2024
),
all_sales AS (
    SELECT [Order Id] AS id, [Amount] AS amt FROM [Sales 2023]
    UNION ALL
    SELECT id, amt FROM sales_2024
)
SELECT id, SUM(amt) AS total FROM all_sales GROUP BY id HAVING SUM(amt) > 0;
