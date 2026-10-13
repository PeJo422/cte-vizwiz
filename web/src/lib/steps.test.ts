import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Ir, Statement } from "../ir";
import { dbtLabel, explainOperation, stepSummary } from "./explain";
import { nodeAtOffset, nodeMap } from "./model";
import { stepColumns } from "./steps";

const golden = (name: string) =>
  (JSON.parse(readFileSync(join(__dirname, "../../../analyzer/tests/golden", `${name}.json`), "utf8")) as Ir).statements[0];
const sqlOf = (name: string) => readFileSync(join(__dirname, "../../../analyzer/tests/fixtures", `${name}.sql`), "utf8");

const kinds = (stmt: Statement, id: string) =>
  stepColumns(stmt, nodeMap(stmt).get(id)!).map((c) => `${c.name}:${c.kind}`);

describe("stepColumns", () => {
  const sales = golden("sales");

  it("filter ändrar inga kolumner", () => {
    expect(kinds(sales, "filtered_orders")).toEqual(["order_id:inherited", "customer_id:inherited", "amount:inherited"]);
  });

  it("group by: aggregat är nytt, övriga kolumner blir spöken på sin gamla plats", () => {
    expect(kinds(sales, "customer_totals")).toEqual([
      "order_id:removed",
      "customer_id:inherited",
      "amount:removed",
      "total_amount:new",
    ]);
  });

  it("join: kolumner från högersidan är nya och bär sitt ursprung", () => {
    const joins = golden("joins");
    const cols = stepColumns(joins, nodeMap(joins).get("enriched")!);
    const name = cols.find((c) => c.name === "customer_name")!;
    expect(name.kind).toBe("new");
    expect(name.origins).toEqual(["customers"]);
    expect(cols.find((c) => c.name === "order_id")!.kind).toBe("inherited");
  });

  it("okända stjärnkolumner markeras som okända, inte gissas", () => {
    expect(kinds(golden("star_unknown"), "src")).toEqual(["*:unknown"]);
  });
});

describe("dbt", () => {
  const unresolved = golden("dbt_unresolved");
  const orders = golden("dbt_orders");

  it("okända makron blir okända kolumner i stegvyn, aldrig gissade", () => {
    const base = kinds(unresolved, "base");
    expect(base).toContain("{{ dbt_utils.star('stg_orders') }}:unknown");
    expect(base).toContain("order_key:unknown");
    expect(base).toContain("amount:inherited");
  });

  it("källnoder bär sin dbt-härkomst och visas som i modellen", () => {
    const n = nodeMap(orders);
    expect(dbtLabel(n.get("shop.raw_orders")!.dbt!)).toBe("source('shop', 'raw_orders')");
    expect(dbtLabel(n.get("stg_customers")!.dbt!)).toBe("ref('stg_customers')");
    expect(n.get("totals")!.dbt).toBeNull();
    expect(dbtLabel({ kind: "ref", name: "dim_user", package: "pkg", version: 2, relation: "dim_user_v2" })).toBe("ref('pkg', 'dim_user', v=2)");
  });

  it("spans ligger i dbt-filen: CTE-namnen går att slå upp i originaltexten", () => {
    const sql = sqlOf("dbt_orders");
    for (const id of ["source_orders", "customers", "filtered", "totals"]) {
      const span = nodeMap(orders).get(id)!.name_span!;
      expect(sql.slice(span.start, span.end)).toBe(id);
    }
    expect(nodeAtOffset(orders, sql.indexOf("{{ ref('stg_customers') }}"))?.id).toBe("customers");
  });
});

describe("förklaringar och positioner", () => {
  const sales = golden("sales");

  it("förklarar filter och aggregate på svenska utan att tolka SQL", () => {
    const n = nodeMap(sales);
    const filter = n.get("filtered_orders")!.operations.find((o) => o.type === "filter")!;
    expect(explainOperation(filter, n.get("filtered_orders")!)).toContain("amount > 100");
    const agg = n.get("customer_totals")!.operations.find((o) => o.type === "aggregate")!;
    expect(explainOperation(agg, n.get("customer_totals")!)).toContain("customer_id");
    expect(stepSummary(n.get("customer_totals")!)).toContain("rader: sammanslagna");
  });

  it("hittar innersta nod vid en textposition", () => {
    const sql = sqlOf("sales");
    const at = (needle: string) => nodeAtOffset(sales, sql.indexOf(needle))?.id;
    expect(at("order_id, customer_id, amount")).toBe("orders");
    expect(at("amount > 100")).toBe("filtered_orders");
    expect(at("SUM(amount)")).toBe("customer_totals");
    expect(at("FROM customer_totals;")).toBe("<output>");
  });
});
