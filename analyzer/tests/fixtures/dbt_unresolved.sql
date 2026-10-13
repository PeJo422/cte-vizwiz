{{ config(materialized='table') }}

WITH base AS (
    SELECT
        {{ dbt_utils.star(ref('stg_orders')) }},
        {{ dbt_utils.generate_surrogate_key(['order_id', 'customer_id']) }} AS order_key,
        amount
    FROM {{ ref('stg_orders') }}
    WHERE order_date >= '{{ var("cutoff") }}'
)
SELECT order_key, amount FROM base
