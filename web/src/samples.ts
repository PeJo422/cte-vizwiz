// Exempel = samma fixturer som Python-testerna använder.
const raw = import.meta.glob("../../analyzer/tests/fixtures/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const LABELS: Record<string, string> = {
  sales: "Enkel kedja (sales.sql)",
  joins: "Join + fönsterfunktion",
  tsql_union: "T-SQL: UNION, TOP, [hakparentes]",
  star_unknown: "SELECT * utan schema",
  subquery: "Underfrågor",
  no_cte: "Utan CTE",
  multi_statement: "Flera statements",
  dbt_orders: "dbt: config, source, ref, loop, makro, var",
  dbt_unresolved: "dbt: okända makron och variabler",
  jinja: "dbt: enkel modell (ref)",
  syntax_error: "Syntaxfel",
};
const ORDER = Object.keys(LABELS);

export interface Sample {
  id: string;
  label: string;
  sql: string;
}

export const SAMPLES: Sample[] = Object.entries(raw)
  .map(([path, sql]) => {
    const id = path.split("/").pop()!.replace(/\.sql$/, "");
    return { id, label: LABELS[id] ?? id, sql: sql.replace(/\r\n/g, "\n") };
  })
  .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

export const DEFAULT_SAMPLE = SAMPLES.find((s) => s.id === "sales") ?? SAMPLES[0];
