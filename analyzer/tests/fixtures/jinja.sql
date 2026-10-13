{{ config(materialized='table') }}
WITH source_data AS (SELECT * FROM {{ ref('stg_orders') }}),
filtered AS (
    SELECT *
    FROM source_data
    WHERE order_status = 'completed'
)
SELECT * FROM filtered
