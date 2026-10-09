{{ config(materialized='table') }}
WITH source_data AS (SELECT * FROM {{ ref('stg_orders') }})
SELECT * FROM source_data
