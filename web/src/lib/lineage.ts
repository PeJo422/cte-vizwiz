import type { Statement } from "../ir";
import { colKey, findColumn, nodeMap } from "./model";

export interface LineageEdge {
  fromNode: string;
  fromCol: string; // kolumnnamn som finns i fromNode
  toNode: string;
  toCol: string;
}

export interface ColRef {
  node: string;
  column: string;
}

export interface Lineage {
  /** colKey för alla kolumner på vägen (inklusive startkolumnen). */
  cols: Set<string>;
  edges: LineageEdge[];
  /** Kolumner uppströms (ursprung) respektive nedströms (användning), i stegordning. Utan startkolumnen. */
  upstream: ColRef[];
  downstream: ColRef[];
}

/**
 * Kolumn-lineage uppströms (var kommer kolumnen ifrån) och nedströms (vad använder den).
 * Hålls medvetet separat från tabell-lineage (stmt.edges).
 */
export function traceLineage(stmt: Statement, nodeId: string, column: string): Lineage {
  const nodes = nodeMap(stmt);
  const start = nodes.get(nodeId);
  const startCol = start && findColumn(start, column);
  const cols = new Set<string>();
  const edges: LineageEdge[] = [];
  if (!start || !startCol) return { cols, edges, upstream: [], downstream: [] };

  // framåtindex: (källnod,källkolumn) → konsumenter
  const consumers = new Map<string, LineageEdge[]>();
  for (const n of stmt.nodes) {
    for (const c of n.columns) {
      for (const s of c.sources) {
        const from = nodes.get(s.node);
        const fromCol = from && findColumn(from, s.column);
        if (!fromCol) continue;
        const e: LineageEdge = { fromNode: s.node, fromCol: fromCol.name, toNode: n.id, toCol: c.name };
        const k = colKey(s.node, fromCol.name);
        consumers.set(k, [...(consumers.get(k) ?? []), e]);
      }
    }
  }

  const seenEdges = new Set<string>();
  const add = (e: LineageEdge) => {
    const k = `${colKey(e.fromNode, e.fromCol)}>${colKey(e.toNode, e.toCol)}`;
    if (seenEdges.has(k)) return false;
    seenEdges.add(k);
    edges.push(e);
    return true;
  };

  cols.add(colKey(nodeId, startCol.name));
  const upstream: ColRef[] = [];
  const downstream: ColRef[] = [];

  // uppströms
  const up = [{ node: nodeId, col: startCol.name }];
  while (up.length) {
    const cur = up.pop()!;
    const n = nodes.get(cur.node)!;
    const c = n.columns.find((x) => x.name === cur.col);
    for (const s of c?.sources ?? []) {
      const from = nodes.get(s.node);
      const fromCol = from && findColumn(from, s.column);
      if (!fromCol) continue;
      cols.add(colKey(s.node, fromCol.name));
      if (add({ fromNode: s.node, fromCol: fromCol.name, toNode: cur.node, toCol: cur.col })) {
        up.push({ node: s.node, col: fromCol.name });
        upstream.push({ node: s.node, column: fromCol.name });
      }
    }
  }

  // nedströms
  const down = [{ node: nodeId, col: startCol.name }];
  while (down.length) {
    const cur = down.pop()!;
    for (const e of consumers.get(colKey(cur.node, cur.col)) ?? []) {
      cols.add(colKey(e.toNode, e.toCol));
      if (add(e)) {
        down.push({ node: e.toNode, col: e.toCol });
        downstream.push({ node: e.toNode, column: e.toCol });
      }
    }
  }

  const rank = new Map(stmt.order.map((id, i) => [id, i]));
  const byStep = (a: ColRef, b: ColRef) => (rank.get(a.node) ?? 0) - (rank.get(b.node) ?? 0) || a.column.localeCompare(b.column);
  const unique = (xs: ColRef[]) => [...new Map(xs.map((x) => [colKey(x.node, x.column), x])).values()].sort(byStep);
  return { cols, edges, upstream: unique(upstream), downstream: unique(downstream) };
}
