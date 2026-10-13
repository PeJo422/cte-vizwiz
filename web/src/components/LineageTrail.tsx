import { useMemo } from "react";

import type { Statement } from "../ir";
import { traceLineage } from "../lib/lineage";
import { displayName, type ColumnFocus } from "../lib/model";

interface Props {
  stmt: Statement;
  focus: ColumnFocus;
  /** Klick på ett led i spåret: gå dit och följ kolumnen därifrån. */
  onFollow: (c: ColumnFocus) => void;
  onClear: () => void;
}

/** Kolumnens ursprung och användning som klickbara namn – följ lineage steg för steg. */
export function LineageTrail({ stmt, focus, onFollow, onClear }: Props) {
  const trail = useMemo(() => traceLineage(stmt, focus.node, focus.column), [stmt, focus]);

  const chips = (items: ColumnFocus[]) => (
    <ul className="trail__chips">
      {items.map((c) => (
        <li key={`${c.node}::${c.column}`}>
          <button type="button" className="chip-link" onClick={() => onFollow(c)} title={`Gå till ${displayName(c.node)} och följ ${c.column}`}>
            <span className="chip-link__node">{displayName(c.node)}</span>
            <span className="chip-link__col">{c.column === "*" ? "*" : c.column}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="trail" aria-label={`Lineage för ${focus.column}`}>
      <div className="trail__head">
        <h3>
          Följer <code>{displayName(focus.node)}.{focus.column}</code>
        </h3>
        <button type="button" className="linkish" onClick={onClear}>Släpp</button>
      </div>
      <div className="trail__row">
        <span className="trail__label">Ursprung</span>
        {trail.upstream.length ? chips(trail.upstream) : <span className="muted">Inget känt ursprung (konstant eller okänd källa).</span>}
      </div>
      <div className="trail__row">
        <span className="trail__label">Används i</span>
        {trail.downstream.length ? chips(trail.downstream) : <span className="muted">Används inte i senare steg.</span>}
      </div>
    </section>
  );
}
