import type { IrNode, Statement } from "../ir";

// Måtten måste matcha styles.css (.cte-card) – kortens höjd är deterministisk.
export const CARD_W = 248;
export const GAP_X = 72;
export const GAP_Y = 36;
const HEADER_H = 44;
const OP_H = 22;
const ROW_H = 24;
const SECTION_PAD = 12;
const FOOTER_H = 32;
const REMOVED_HEADER_H = 22;

export const visibleOps = (n: IrNode) => n.operations.filter((o) => o.type !== "select");

export function cardHeight(n: IrNode): number {
  const ops = visibleOps(n).length;
  const removed = n.columns_removed.length;
  return (
    HEADER_H +
    (ops ? ops * OP_H + SECTION_PAD : 0) +
    Math.max(n.columns.length, 1) * ROW_H +
    SECTION_PAD +
    (removed ? REMOVED_HEADER_H + removed * ROW_H : 0) +
    (n.kind === "source" ? 0 : FOOTER_H)
  );
}

/** Lager = längsta vägen från en källa. Vänster→höger, noder staplas per lager. */
export function layoutNodes(stmt: Statement): Map<string, { x: number; y: number }> {
  const byId = new Map(stmt.nodes.map((n) => [n.id, n]));
  const layer = new Map<string, number>();
  const depth = (id: string, seen = new Set<string>()): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0; // skydd mot cykler (rekursiva CTE:er)
    seen.add(id);
    const n = byId.get(id);
    const d = n && n.inputs.length ? 1 + Math.max(...n.inputs.map((i) => (byId.has(i.node) ? depth(i.node, seen) : 0))) : 0;
    layer.set(id, d);
    return d;
  };
  stmt.nodes.forEach((n) => depth(n.id));

  const columns = new Map<number, IrNode[]>();
  for (const n of stmt.nodes) {
    const l = layer.get(n.id) ?? 0;
    columns.set(l, [...(columns.get(l) ?? []), n]);
  }
  const heights = new Map<number, number>();
  for (const [l, ns] of columns) {
    heights.set(l, ns.reduce((h, n) => h + cardHeight(n), 0) + GAP_Y * (ns.length - 1));
  }
  const tallest = Math.max(0, ...heights.values());

  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, ns] of columns) {
    let y = (tallest - heights.get(l)!) / 2;
    for (const n of ns) {
      pos.set(n.id, { x: l * (CARD_W + GAP_X), y });
      y += cardHeight(n) + GAP_Y;
    }
  }
  return pos;
}
