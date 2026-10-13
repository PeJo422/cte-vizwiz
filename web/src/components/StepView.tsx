import { useMemo, type KeyboardEvent } from "react";

import type { IrNode, Span, Statement } from "../ir";
import { CHANGE_LABEL, stepSummary } from "../lib/explain";
import { traceLineage } from "../lib/lineage";
import { colKey, displayName, nodeMap, sameColumn, sliceSpan, type ColumnFocus } from "../lib/model";
import { stepColumns, type StepColumn } from "../lib/steps";
import { LineageTrail } from "./LineageTrail";
import { OperationList } from "./OperationList";

interface Props {
  stmt: Statement;
  sql: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  hoverSpan: (span: Span | null) => void;
  pinned: ColumnFocus | null;
  onPinColumn: (c: ColumnFocus | null) => void;
  /** Följ lineage till ett annat led (hoppar till det steget och låser kolumnen där). */
  onFollow: (c: ColumnFocus) => void;
}

const PLACEHOLDER_ROWS: Record<IrNode["shape"]["rows"], number> = { same: 4, fewer: 3, more: 6, collapsed: 2, unknown: 4 };
const BANDS = 6;

const cellTitle = (c: StepColumn, clickable: boolean) =>
  [c.expression, CHANGE_LABEL[c.change], clickable ? "Klicka för att följa lineage" : ""].filter(Boolean).join("\n");

const KIND_TEXT: Record<StepColumn["kind"], string> = {
  inherited: "ärvd",
  new: "ny",
  modified: "omräknad",
  removed: "borttagen",
  unknown: "okänd",
};

export function StepView({ stmt, sql, selectedId, onSelect, hoverSpan, pinned, onPinColumn, onFollow }: Props) {
  const order = stmt.order;
  const byId = useMemo(() => nodeMap(stmt), [stmt]);
  const index = Math.max(0, selectedId ? order.indexOf(selectedId) : order.length - 1);
  const node = byId.get(order[index])!;
  const cols = useMemo(() => stepColumns(stmt, node), [stmt, node]);
  const band = (id: string) => Math.max(0, order.indexOf(id)) % BANDS;

  const go = (i: number) => onSelect(order[Math.min(Math.max(i, 0), order.length - 1)]);
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest("button, select, input")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); go(index + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(index - 1); }
  };

  const lineage = useMemo(() => (pinned ? traceLineage(stmt, pinned.node, pinned.column) : null), [stmt, pinned]);

  const origins = [...new Set(cols.filter((c) => c.kind === "new" || c.kind === "modified").flatMap((c) => c.origins))];
  const code = sliceSpan(sql, node.body_span ?? node.span).trim();
  const live = cols.filter((c) => c.kind !== "removed").length;

  return (
    <div className="steps" tabIndex={0} onKeyDown={onKey} aria-label="Steg för steg. Använd vänster- och högerpil.">
      <div className="steps__bar">
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0}>Föregående</button>
        <ol className="steps__track" aria-label="Steg">
          {order.map((id, i) => (
            <li key={id}>
              <button
                type="button"
                className={`dot${i === index ? " is-current" : ""}${i < index ? " is-done" : ""}`}
                onClick={() => go(i)}
                aria-current={i === index ? "step" : undefined}
                title={displayName(id)}
              >
                <span className="dot__n">{i + 1}</span>
                <span className="dot__label">{displayName(id)}</span>
              </button>
            </li>
          ))}
        </ol>
        <button type="button" onClick={() => go(index + 1)} disabled={index === order.length - 1}>Nästa</button>
      </div>

      <section className="steps__main" aria-live="polite">
        <h2>
          Steg {index + 1} av {order.length}: {displayName(node.id)}
          <small>{node.kind === "source" ? "källtabell, bara kolumner som frågan använder" : node.kind === "output" ? "slutresultat" : "CTE"}</small>
        </h2>
        <p className="steps__summary">{node.kind === "source" ? `${live} kolumner används från källan.` : stepSummary(node)}</p>

        <div className="grid" role="table" aria-label={`Kolumner i ${displayName(node.id)} (ingen data visas)`}>
          <div className="grid__head" role="row">
            {cols.map((c) => {
              const focus: ColumnFocus = { node: node.id, column: c.name };
              const clickable = c.kind !== "removed";
              const isPinned = sameColumn(pinned, focus);
              const inLineage = lineage?.cols.has(colKey(node.id, c.name)) ?? false;
              const toggle = () => onPinColumn(isPinned ? null : focus);
              return (
                <div
                  key={`${c.kind}:${c.name}`}
                  role="columnheader"
                  className={`cell kind-${c.kind} change-${c.change}${clickable ? " is-clickable" : ""}${isPinned ? " is-pinned" : ""}${inLineage && !isPinned ? " in-lineage" : ""}`}
                  style={c.origins[0] ? { ["--band" as string]: `var(--band-${band(c.origins[0])})` } : undefined}
                  title={cellTitle(c, clickable)}
                  {...(clickable
                    ? {
                        tabIndex: 0,
                        "aria-pressed": isPinned,
                        onClick: toggle,
                        onKeyDown: (e: KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(); }
                        },
                      }
                    : {})}
                >
                  <span className="cell__name">{c.name === "*" ? "*" : c.name}</span>
                  <span className="cell__meta">{KIND_TEXT[c.kind]}</span>
                </div>
              );
            })}
          </div>
          {Array.from({ length: PLACEHOLDER_ROWS[node.shape.rows] }, (_, r) => (
            <div className="grid__row" role="row" key={r} aria-hidden="true">
              {cols.map((c, i) => (
                <div key={i} className={`cell cell--ph kind-${c.kind}`}><span className="ph" style={{ width: `${45 + ((r * 7 + i * 13) % 40)}%` }} /></div>
              ))}
            </div>
          ))}
        </div>
        {pinned && <LineageTrail stmt={stmt} focus={pinned} onFollow={onFollow} onClear={() => onPinColumn(null)} />}
        {!pinned && <p className="muted steps__nodata">Klicka på ett kolumnnamn för att följa lineage.</p>}
        <p className="muted steps__nodata">Ingen data visas, bara kolumnstrukturen.</p>

        <ul className="legend" aria-label="Teckenförklaring">
          <li><span className="swatch kind-inherited" /> ärvd kolumn</li>
          <li><span className="swatch kind-new" /> ny kolumn</li>
          <li><span className="swatch kind-modified" /> omräknad</li>
          <li><span className="swatch kind-removed" /> borttagen</li>
          <li><span className="swatch kind-unknown" /> okänd (<code>*</code> eller dbt-makro)</li>
          {origins.map((o) => (
            <li key={o}><span className="swatch band" style={{ ["--band" as string]: `var(--band-${band(o)})` }} /> från {displayName(o)}</li>
          ))}
        </ul>
      </section>

      {node.kind !== "source" && (
        <section className="steps__ops">
          <h3>Operationer i steget</h3>
          <OperationList node={node} onHover={hoverSpan} />
        </section>
      )}

      {code && (
        <section className="steps__code">
          <h3>Källkod</h3>
          <pre><code>{code}</code></pre>
        </section>
      )}
    </div>
  );
}
