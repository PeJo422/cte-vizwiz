import type { Change, DbtNodeInfo, IrNode, Operation, RowEffect } from "../ir";
import { displayName } from "./model";

/** Kort förklaring av en operation. Bygger bara på IR:n, ingen SQL-tolkning. */
export function explainOperation(op: Operation, node: IrNode): string {
  const d = op.details;
  switch (op.type) {
    case "filter": {
      const after = d.clause === "HAVING" ? " (efter GROUP BY)" : d.clause === "QUALIFY" ? " (efter fönsterfunktionen)" : "";
      return `Rader där ${op.expression} behålls${after}. Kolumnerna ändras inte.`;
    }
    case "join": {
      const cond = d.on ? ` på ${d.on}` : d.using ? ` på ${d.using.join(", ")}` : "";
      return `Lägger till kolumner från ${d.source ?? "en annan källa"}. ${d.join_type ?? "INNER"} JOIN${cond}.`;
    }
    case "aggregate":
      return d.group_by && d.group_by.length
        ? `Grupperar på ${d.group_by.join(", ")}. Efter det finns bara gruppnycklarna och aggregaten kvar.`
        : "Ingen GROUP BY, så alla rader blir en. Bara aggregaten finns kvar.";
    case "distinct":
      return "Tar bort dubbletter bland raderna.";
    case "union":
      return `${d.kind ?? "UNION"}: raderna från nästa gren läggs under. Kolumnerna matchas på position, inte på namn.`;
    case "window":
      return "Fönsterfunktion. Beräknas över relaterade rader utan att raderna slås ihop.";
    case "order":
      return `Sorterar på ${op.expression}.`;
    case "limit":
      return `Begränsar antalet rader (${op.expression}).`;
    case "select":
      return node.columns.length === 1 ? "Väljer 1 kolumn." : `Väljer ${node.columns.length} kolumner.`;
  }
}

export const OP_LABEL: Record<Operation["type"], string> = {
  select: "SELECT",
  filter: "FILTER",
  join: "JOIN",
  aggregate: "GROUP BY",
  distinct: "DISTINCT",
  union: "UNION",
  window: "WINDOW",
  order: "ORDER",
  limit: "LIMIT",
};

export const ROWS_LABEL: Record<RowEffect, string> = {
  same: "rader: samma",
  fewer: "rader: färre",
  more: "rader: fler",
  collapsed: "rader: sammanslagna",
  unknown: "rader: oklart",
};

export const CHANGE_LABEL: Record<Change, string> = {
  source: "källkolumn",
  passthrough: "oförändrad",
  renamed: "omdöpt",
  derived: "beräknad",
  aggregate: "aggregat",
  window: "fönsterfunktion",
  literal: "konstant",
  merged: "sammanslagen (UNION)",
  star_unknown: "okända kolumner (*)",
  unresolved: "okänt dbt-makro",
};

/** dbt-uttrycket en källnod kommer från, som det skrivs i modellen. */
export function dbtLabel(info: DbtNodeInfo): string {
  switch (info.kind) {
    case "ref": {
      const args = [info.package, info.name].filter(Boolean).map((a) => `'${a}'`);
      if (info.version !== null) args.push(`v=${info.version}`);
      return `ref(${args.join(", ")})`;
    }
    case "source":
      return `source('${info.source}', '${info.table}')`;
    case "this":
      return "this";
    case "unresolved":
      return `{{ ${info.text} }}`;
  }
}

export const DBT_KIND_LABEL: Record<DbtNodeInfo["kind"], string> = {
  ref: "dbt ref",
  source: "dbt source",
  this: "dbt this",
  unresolved: "dbt makro",
};

export function widthSummary(node: IrNode): string | null {
  const w = node.shape.width_delta;
  if (w === null) return null;
  if (w === 0) return "kolumner: samma";
  return `kolumner: ${w > 0 ? "+" : ""}${w}`;
}

export function stepSummary(node: IrNode): string {
  const parts: string[] = [];
  if (node.columns_added.length) parts.push(`+${node.columns_added.length} nya kolumner`);
  if (node.columns_removed.length) parts.push(`−${node.columns_removed.length} borttagna`);
  if (node.columns_modified.length) parts.push(`${node.columns_modified.length} omräknade`);
  parts.push(ROWS_LABEL[node.shape.rows]);
  return `${displayName(node.id)}: ${parts.join(", ")}`;
}
