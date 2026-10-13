import type { Change, IrNode, Statement } from "../ir";
import { nodeMap } from "./model";

export type StepKind = "inherited" | "new" | "modified" | "removed" | "unknown";

export interface StepColumn {
  name: string;
  kind: StepKind;
  change: Change;
  expression: string;
  /** Noder som kolumnen härstammar från (för färgband). */
  origins: string[];
}

/**
 * Kolumnerna i ett steg jämfört med stegets primära input: ärvda, nya, omräknade
 * och borttagna (spöken på sin gamla plats). Tabellen "växer åt höger" när nya
 * kolumner läggs till och krymper när kolumner tas bort.
 */
export function stepColumns(stmt: Statement, node: IrNode): StepColumn[] {
  const prev = nodeMap(stmt).get(node.inputs[0]?.node ?? "") ?? null;
  const prevNames = new Map((prev?.columns ?? []).map((c, i) => [c.name.toLowerCase(), i]));

  const current: StepColumn[] = node.columns.map((c) => {
    const known = prevNames.has(c.name.toLowerCase());
    let kind: StepKind;
    if (c.change === "star_unknown" || c.change === "unresolved") kind = "unknown";
    else if (node.kind === "source") kind = "inherited";
    else if (!known) kind = "new";
    else kind = c.change === "passthrough" ? "inherited" : "modified";
    const origins = [...new Set(c.sources.map((s) => s.node))];
    return { name: c.name, kind, change: c.change, expression: c.expression, origins };
  });

  const outNames = new Set(node.columns.map((c) => c.name.toLowerCase()));
  const ghosts = (prev?.columns ?? [])
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.name !== "*" && !outNames.has(c.name.toLowerCase()) && node.kind !== "source");

  // spöken tillbaka på sin gamla position (klampad)
  const result = [...current];
  for (const { c, i } of ghosts) {
    result.splice(Math.min(i, result.length), 0, {
      name: c.name,
      kind: "removed",
      change: c.change,
      expression: c.expression,
      origins: prev ? [prev.id] : [],
    });
  }
  return result;
}
