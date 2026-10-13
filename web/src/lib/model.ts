import type { Column, Ir, IrNode, Span, Statement } from "../ir";

export function pickStatement(ir: Ir | null, index: number): Statement | null {
  if (!ir || ir.statements.length === 0) return null;
  return ir.statements[Math.min(index, ir.statements.length - 1)];
}

export function nodeMap(stmt: Statement): Map<string, IrNode> {
  return new Map(stmt.nodes.map((n) => [n.id, n]));
}

/** En kolumn i en nod – det som markeras, låses och följs i visualiseringen. */
export interface ColumnFocus {
  node: string;
  column: string;
}

export const sameColumn = (a: ColumnFocus | null, b: ColumnFocus | null) =>
  !!a && !!b && a.node === b.node && a.column.toLowerCase() === b.column.toLowerCase();

export const displayName = (id: string) => (id === "<output>" ? "Resultat" : id);

const contains = (s: Span, offset: number) => offset >= s.start && offset <= s.end;

/** Innersta CTE/resultat-nod vars källtext innehåller offseten (editor → visualisering). */
export function nodeAtOffset(stmt: Statement, offset: number): IrNode | null {
  let best: IrNode | null = null;
  for (const n of stmt.nodes) {
    if (!n.span || !contains(n.span, offset)) continue;
    if (!best || n.span.end - n.span.start < best.span!.end - best.span!.start) best = n;
  }
  return best;
}

/** Hitta kolumnen i en nod (skiftlägesokänsligt), med `*` som reträtt när kolumner är okända. */
export function findColumn(node: IrNode, name: string): Column | null {
  const low = name.toLowerCase();
  return (
    node.columns.find((c) => c.name.toLowerCase() === low) ??
    node.columns.find((c) => c.name === "*") ??
    null
  );
}

export const colKey = (nodeId: string, column: string) => `${nodeId}::${column.toLowerCase()}`;

/** Ordning för stegvyn: källor först, sedan CTE:er i deklarationsordning, sist resultatet. */
export function stepOrder(stmt: Statement): string[] {
  return stmt.order;
}

export function sliceSpan(sql: string, span: Span | null): string {
  return span ? sql.slice(span.start, span.end) : "";
}
