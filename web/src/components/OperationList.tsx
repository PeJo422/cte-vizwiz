import type { IrNode } from "../ir";
import { explainOperation, OP_LABEL } from "../lib/explain";

interface Props {
  node: IrNode;
  /** Tar även med den triviala SELECT-operationen. */
  showSelect?: boolean;
  onHover?: (span: IrNode["operations"][number]["span"]) => void;
}

export function OperationList({ node, showSelect = false, onHover }: Props) {
  const ops = node.operations.filter((o) => showSelect || o.type !== "select");
  if (ops.length === 0) {
    return <p className="muted">Ingen operation utöver SELECT. Kolumnerna väljs rakt av.</p>;
  }
  return (
    <ol className="oplist">
      {ops.map((op, i) => (
        <li key={i} onMouseEnter={() => onHover?.(op.span)} onMouseLeave={() => onHover?.(null)}>
          <span className={`chip chip-${op.type}`}>{op.type === "filter" && op.details.clause === "HAVING" ? "HAVING" : OP_LABEL[op.type]}</span>
          <code className="oplist__expr">{op.expression}</code>
          <span className="oplist__why">{explainOperation(op, node)}</span>
        </li>
      ))}
    </ol>
  );
}
