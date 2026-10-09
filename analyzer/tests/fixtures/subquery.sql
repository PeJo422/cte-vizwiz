WITH base AS (
    SELECT a.id, a.v FROM (SELECT id, v FROM t WHERE v > 0) a
)
SELECT id, (SELECT MAX(v) FROM t2) AS m FROM base
