import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION, type Ir } from "./ir";
import { traceLineage } from "./lib/lineage";
import { cardHeight, layoutNodes } from "./lib/layout";

// Kontraktstest: golden-IR:erna från Python-analysatorn måste ha exakt de fält och
// värden som ir.ts lovar. Ändras analysatorn utan att ir.ts följer med faller detta.
const goldenDir = join(__dirname, "../../analyzer/tests/golden");
const files = readdirSync(goldenDir).filter((f) => f.endsWith(".json"));

const STATUS = ["ok", "partial", "error"];
const KIND = ["source", "cte", "output"];
const CHANGE = ["source", "passthrough", "renamed", "derived", "aggregate", "window", "literal", "merged", "star_unknown", "unresolved"];
const DBT_KIND = ["ref", "source", "this", "unresolved"];
const OPS = ["select", "filter", "join", "aggregate", "distinct", "union", "window", "order", "limit"];
const ROWS = ["same", "fewer", "more", "collapsed", "unknown"];
const ROLE = ["from", "join", "union"];

const keys = (o: object) => Object.keys(o).sort();
const load = (f: string) => JSON.parse(readFileSync(join(goldenDir, f), "utf8")) as Ir;

describe("IR-kontrakt mot golden-filer", () => {
  it("hittar golden-filer", () => expect(files.length).toBeGreaterThan(5));

  it.each(files)("%s följer ir.ts", (file) => {
    const ir = load(file);
    expect(keys(ir)).toEqual(["dbt", "dialect", "errors", "schema_version", "statements", "status", "warnings"]);
    if (ir.dbt) {
      expect(keys(ir.dbt)).toEqual(["config", "is_incremental", "refs", "rendered_sql", "sources", "unresolved", "vars"]);
      for (const v of ir.dbt.vars) expect(keys(v)).toEqual(["from", "kind", "name", "resolved", "value"]);
      for (const u of ir.dbt.unresolved) expect(["macro", "name", "var"]).toContain(u.kind);
    }
    expect(ir.schema_version).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(STATUS).toContain(ir.status);
    for (const w of ir.warnings) {
      expect(["warning", "info"]).toContain(w.level);
      expect(typeof w.code).toBe("string");
    }
    for (const st of ir.statements) {
      expect(keys(st)).toEqual(["edges", "index", "nodes", "order", "output_node", "span"]);
      expect(st.order).toEqual(st.nodes.map((n) => n.id));
      for (const e of st.edges) {
        expect(ROLE).toContain(e.role);
        expect(st.order).toContain(e.from);
        expect(st.order).toContain(e.to);
      }
      for (const n of st.nodes) {
        expect(keys(n)).toEqual([
          "body_span", "columns", "columns_added", "columns_modified", "columns_removed", "dbt", "id", "inputs",
          "kind", "name_span", "operations", "shape", "span",
        ]);
        expect(KIND).toContain(n.kind);
        if (n.dbt) {
          expect(DBT_KIND).toContain(n.dbt.kind);
          expect(n.kind).toBe("source");
        }
        expect(ROWS).toContain(n.shape.rows);
        for (const c of n.columns) {
          expect(keys(c)).toEqual(["change", "expression", "name", "sources", "span", "via_star"]);
          expect(CHANGE).toContain(c.change);
          for (const s of c.sources) expect(keys(s)).toEqual(["column", "node"]);
        }
        for (const o of n.operations) {
          expect(keys(o)).toEqual(["details", "expression", "span", "type"]);
          expect(OPS).toContain(o.type);
        }
        for (const i of n.inputs) {
          expect(ROLE).toContain(i.role);
          expect(st.order).toContain(i.node);
        }
      }
    }
  });
});

describe("lineage och layout på sales.sql", () => {
  const stmt = load("sales.json").statements[0];

  it("total_amount spåras bakåt till raw_orders.amount och framåt till resultatet", () => {
    const l = traceLineage(stmt, "customer_totals", "total_amount");
    expect([...l.cols].sort()).toEqual([
      "<output>::total_amount",
      "customer_totals::total_amount",
      "filtered_orders::amount",
      "orders::amount",
      "raw_orders::amount",
    ]);
    expect(l.edges).toHaveLength(4);
  });

  it("ger ursprung och användning som ordnade spår att klicka sig fram", () => {
    const l = traceLineage(stmt, "filtered_orders", "amount");
    expect(l.upstream).toEqual([
      { node: "raw_orders", column: "amount" },
      { node: "orders", column: "amount" },
    ]);
    expect(l.downstream).toEqual([{ node: "customer_totals", column: "total_amount" }, { node: "<output>", column: "total_amount" }]);
  });

  it("lägger noderna i lager från vänster till höger", () => {
    const pos = layoutNodes(stmt);
    const xs = stmt.order.map((id) => pos.get(id)!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(5);
  });

  it("kortens höjd växer med antal kolumner", () => {
    const [orders, totals] = [stmt.nodes.find((n) => n.id === "orders")!, stmt.nodes.find((n) => n.id === "customer_totals")!];
    expect(cardHeight(orders)).toBeGreaterThan(0);
    expect(cardHeight(totals)).not.toBe(cardHeight(orders));
  });
});
