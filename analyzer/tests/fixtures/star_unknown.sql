WITH src AS (SELECT * FROM raw.events),
typed AS (SELECT *, CAST(ts AS date) AS day FROM src)
SELECT * FROM typed
