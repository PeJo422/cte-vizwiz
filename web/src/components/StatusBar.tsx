import { useState } from "react";

import type { Ir, Span } from "../ir";

interface Props {
  ir: Ir | null;
  stale: boolean;
  busy: boolean;
  runtimeMessage: string | null;
  onGoto: (span: Span) => void;
}

const STATUS_TEXT = {
  ok: "Analys OK",
  partial: "Delvis analys, se varningar",
  error: "Analysen misslyckades",
} as const;

export function StatusBar({ ir, stale, busy, runtimeMessage, onGoto }: Props) {
  const [open, setOpen] = useState(false);
  const items = [
    ...(ir?.errors ?? []).map((e) => ({ level: "error" as const, text: e.message, span: e.span })),
    ...(ir?.warnings ?? []).map((w) => ({ level: w.level, text: w.message, span: w.span })),
  ];
  const attention = items.filter((i) => i.level !== "info").length;
  const status = ir?.status ?? "partial";

  return (
    <footer className="statusbar">
      <div className="statusbar__row">
        <span className={`pill pill-${runtimeMessage ? "partial" : status}`}>
          {runtimeMessage ?? (busy ? "Analyserar…" : STATUS_TEXT[status])}
        </span>
        {ir?.dbt && <span className="pill pill-dbt" title="Jinja renderades till SQL före analysen">dbt</span>}
        {stale && <span className="muted">Visar senaste lyckade analysen. Koden har ett fel.</span>}
        {items.length > 0 && (
          <button type="button" className="linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
            {attention} {attention === 1 ? "varning" : "varningar"}{items.length > attention ? `, ${items.length - attention} info` : ""}
          </button>
        )}
        <span className="statusbar__spacer" />
        <span className="muted" title="Analysen körs i webbläsaren. Inga nätverksanrop görs.">Ingen databasanslutning. Allt körs lokalt.</span>
      </div>
      {open && (
        <ul className="statusbar__list">
          {items.map((it, i) => (
            <li key={i} className={`lvl-${it.level}`}>
              <span className="lvl">{it.level === "error" ? "Fel" : it.level === "warning" ? "Varning" : "Info"}</span>
              {it.text}
              {it.span && (
                <button type="button" className="linkish" onClick={() => onGoto(it.span!)}>
                  rad {it.span.line}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}
