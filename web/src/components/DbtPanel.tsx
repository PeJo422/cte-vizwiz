import { useEffect, useRef, useState } from "react";

import type { Ir, Span } from "../ir";

export interface DbtSettings {
  /** Rendera dbt-Jinja. Av = behandla filen som ren SQL. */
  enabled: boolean;
  isIncremental: boolean;
  /** JSON-objekt för var(). */
  varsText: string;
  /** `{% macro %}`-definitioner som modellen får använda. */
  macros: string;
}

interface Props {
  ir: Ir | null;
  settings: DbtSettings;
  onChange: (s: DbtSettings) => void;
  varsError: string | null;
  onGoto: (span: Span) => void;
  onClose: () => void;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function DbtPanel({ ir, settings, onChange, varsError, onGoto, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const d = ir?.dbt ?? null;
  const set = (patch: Partial<DbtSettings>) => onChange({ ...settings, ...patch });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // klick på själva dbt-knappen i topplisten hanteras av knappen (växlar)
      if (!root.current?.contains(target) && !(target as HTMLElement).closest?.("[data-dbt-toggle]")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(d?.rendered_sql ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* urklipp kan vara blockerat – texten går att markera ändå */
    }
  };

  const goto = (span: Span | null) => span && onGoto(span);
  const chip = (key: string, label: string, span: Span | null, cls = "") => (
    <li key={key}>
      <button type="button" className={`chip-link ${cls}`} onClick={() => goto(span)} disabled={!span} title={span ? `Visa i koden (rad ${span.line})` : undefined}>
        <span className="chip-link__col">{label}</span>
      </button>
    </li>
  );

  return (
    <div className="popover dbtpanel" role="dialog" aria-label="dbt" ref={root}>
      <header className="popover__head">
        <h2>dbt</h2>
        <button type="button" className="tool" onClick={onClose}>Stäng</button>
      </header>

      <label className="check">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>
          Rendera dbt-Jinja
          <small>Kör Jinja på filen före analysen: <code>ref</code>, <code>source</code>, <code>config</code>, <code>var</code>, loopar och makron. Avstängt tolkas filen som ren SQL.</small>
        </span>
      </label>

      {settings.enabled && (
        <>
          {d ? (
            <section className="dbtpanel__sum" aria-label="Det som hittades">
              {Object.keys(d.config).length > 0 && (
                <>
                  <h3>config</h3>
                  <ul className="kv">
                    {Object.entries(d.config).map(([k, v]) => (
                      <li key={k}><span>{k}</span><code>{show(v)}</code></li>
                    ))}
                  </ul>
                </>
              )}
              {d.refs.length > 0 && (
                <>
                  <h3>ref</h3>
                  <ul className="trail__chips">{d.refs.map((r) => chip(`r:${r.relation}`, r.kind === "this" ? "this" : r.relation, r.span))}</ul>
                </>
              )}
              {d.sources.length > 0 && (
                <>
                  <h3>source</h3>
                  <ul className="trail__chips">{d.sources.map((s) => chip(`s:${s.relation}`, s.relation, s.span))}</ul>
                </>
              )}
              {d.vars.length > 0 && (
                <>
                  <h3>var / env_var</h3>
                  <ul className="kv">
                    {d.vars.map((v) => (
                      <li key={`${v.kind}:${v.name}`}>
                        <span>{v.name}</span>
                        {v.resolved ? <code>{show(v.value)}</code> : <code className="err">saknas</code>}
                        <small className="muted">{v.from === "options" ? "inställd" : v.from === "default" ? "standardvärde" : ""}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {d.unresolved.length > 0 && (
                <>
                  <h3>Kunde inte lösas</h3>
                  <ul className="trail__chips">{d.unresolved.map((u) => chip(`u:${u.text}`, u.text, u.span, "is-warn"))}</ul>
                  <p className="muted">Visas som <code>?</code>-kolumner i diagrammet. Lös dem genom att klistra in makrot eller ange variabeln nedan.</p>
                </>
              )}
            </section>
          ) : (
            <p className="muted">Ingen Jinja i koden. Exemplen som börjar med <em>dbt:</em> finns i listan.</p>
          )}

          <h3>Antaganden</h3>
          <label className="check">
            <input type="checkbox" checked={settings.isIncremental} onChange={(e) => set({ isIncremental: e.target.checked })} />
            <span>
              <code>is_incremental()</code> är sant
              <small>Renderar den inkrementella grenen. Avstängt är full körning.</small>
            </span>
          </label>

          <label className="stack">
            <span>Värden för <code>var()</code> (JSON)</span>
            <textarea rows={3} spellCheck={false} value={settings.varsText} onChange={(e) => set({ varsText: e.target.value })} aria-invalid={!!varsError} placeholder='{"start_date": "2024-01-01"}' />
          </label>
          {varsError && <p className="err">{varsError}</p>}

          <label className="stack">
            <span>Egna makron</span>
            <textarea rows={6} spellCheck={false} value={settings.macros} onChange={(e) => set({ macros: e.target.value })} placeholder={"{% macro cents_to_dollars(col) %}\n  ({{ col }} / 100.0)\n{% endmacro %}"} />
          </label>

          {d && (
            <details className="dbtpanel__sql">
              <summary>Kompilerad SQL</summary>
              <button type="button" className="tool" onClick={copy}>{copied ? "Kopierad" : "Kopiera"}</button>
              <pre><code>{d.rendered_sql}</code></pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
