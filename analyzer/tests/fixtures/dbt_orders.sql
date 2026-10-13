{{ config(materialized='incremental', unique_key='order_id', tags=['finance']) }}

{% set statuses = ['completed', 'shipped'] %}

{% macro to_dollars(col) %}ROUND({{ col }} / 100.0, 2){% endmacro %}

WITH source_orders AS (
    SELECT order_id, customer_id, amount, status, order_date
    FROM {{ source('shop', 'raw_orders') }}
    {% if is_incremental() %}
    WHERE order_date > (SELECT MAX(order_date) FROM {{ this }})
    {% endif %}
),
customers AS (
    SELECT customer_id, customer_name FROM {{ ref('stg_customers') }}
),
filtered AS (
    SELECT o.*, c.customer_name
    FROM source_orders o
    LEFT JOIN customers c ON c.customer_id = o.customer_id
    WHERE o.status IN (
        {%- for s in statuses %}'{{ s }}'{{ "," if not loop.last }}{% endfor -%}
    )
      AND o.order_date >= '{{ var("start_date", "2024-01-01") }}'
),
totals AS (
    SELECT
        customer_id,
        customer_name,
        {{ to_dollars('SUM(amount)') }} AS total_dollars
    FROM filtered
    GROUP BY customer_id, customer_name
)
SELECT * FROM totals
