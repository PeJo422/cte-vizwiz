import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DbtPanel, type DbtSettings } from "./components/DbtPanel";
import { EditorPane, type Highlights, type RevealRequest } from "./components/EditorPane";
import { FlowView, type ColumnFocus, type FocusRequest } from "./components/FlowView";
import { Splitter } from "./components/Splitter";
import { StatusBar } from "./components/StatusBar";
import { StepView } from "./components/StepView";
import { webHost } from "./host";
import { OUTPUT_ID, type Ir, type Span } from "./ir";
import { findColumn, nodeAtOffset, nodeMap, pickStatement } from "./lib/model";
import { isBoolean, isNumber, isString, usePersistentState } from "./lib/persist";
import { DEFAULT_SAMPLE, SAMPLES } from "./samples";
import { analyzer, StaleError, type RuntimeState } from "./worker/client";
import type { AnalyzeOptions } from "./worker/protocol";

const DIALECTS = [
  { id: "tsql", label: "T-SQL" },
  { id: "snowflake", label: "Snowflake" },
  { id: "databricks", label: "Databricks" },
  { id: "postgres", label: "PostgreSQL" },
  { id: "bigquery", label: "BigQuery" },
];

type View = "flow" | "steps";

function parseVars(text: string): { value: Record<string, unknown> | undefined; error: string | null } {
  if (!text.trim()) return { value: undefined, error: null };
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return { value: v as Record<string, unknown>, error: null };
    return { value: undefined, error: "Måste vara ett JSON-objekt, t.ex. {\"start_date\": \"2024-01-01\"}." };
  } catch (e) {
    return { value: undefined, error: `Ogiltig JSON: ${(e as Error).message}` };
  }
}
interface Good { ir: Ir; sql: string }

export default function App() {
  const [sql, setSql] = useState(() => webHost.loadSql() ?? DEFAULT_SAMPLE.sql);
  const [dialect, setDialect] = useState("tsql");
  const [view, setView] = useState<View>("flow");
  const [runtime, setRuntime] = useState<RuntimeState>({ state: "loading", message: "Startar…" });
  const [latest, setLatest] = useState<Good | null>(null);
  const [good, setGood] = useState<Good | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [stmtIndex, setStmtIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverCol, setHoverCol] = useState<ColumnFocus | null>(null);
  const [pinnedCol, setPinnedCol] = useState<ColumnFocus | null>(null);
  const [opSpan, setOpSpan] = useState<Span | null>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const nonce = useRef(0);
  const [editorW, setEditorW] = usePersistentState("editor-w", 440, isNumber);
  const [showEditor, setShowEditor] = usePersistentState("show-editor", true, isBoolean);
  const [wrap, setWrap] = usePersistentState("wrap", false, isBoolean);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [dbtEnabled, setDbtEnabled] = usePersistentState("dbt-enabled", true, isBoolean);
  const [isIncremental, setIsIncremental] = usePersistentState("dbt-incremental", false, isBoolean);
  const [varsText, setVarsText] = usePersistentState("dbt-vars", "", isString);
  const [macros, setMacros] = usePersistentState("dbt-macros", "", isString);
  const [dbtOpen, setDbtOpen] = useState(false);
  const parsedVars = useMemo(() => parseVars(varsText), [varsText]);
  const options = useMemo<AnalyzeOptions>(
    () => ({ dbt: dbtEnabled, vars: parsedVars.value, macros, is_incremental: isIncremental }),
    [dbtEnabled, parsedVars, macros, isIncremental],
  );
  const dbtSettings: DbtSettings = { enabled: dbtEnabled, isIncremental, varsText, macros };
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);

  useEffect(() => analyzer().subscribe(setRuntime), []);

  // debouncad analys; senaste anropet vinner
  useEffect(() => {
    webHost.saveSql(sql);
    setBusy(true);
    const t = setTimeout(() => {
      analyzer()
        .analyze(sql, dialect, options)
        .then((ir) => {
          setLatest({ ir, sql });
          setFailure(null);
          if (ir.status !== "error") setGood({ ir, sql });
          setBusy(false);
        })
        .catch((e: Error) => {
          if (e instanceof StaleError) return;
          setFailure(e.message);
          setBusy(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [sql, dialect, options]);

  const latestFailed = latest?.ir.status === "error";
  const shown = latest && !latestFailed ? latest : good;
  const stale = latestFailed && good !== null;
  const stmt = pickStatement(shown?.ir ?? null, stmtIndex);
  const shownSql = shown?.sql ?? sql;
  // positionerna gäller texten som analyserades – inaktuella så fort koden ändrats
  const positionsValid = !stale && shownSql === sql;

  // ogiltigt val efter ny analys → resultatnoden
  useEffect(() => {
    if (!stmt) return;
    setSelectedId((cur) => (cur && stmt.order.includes(cur) ? cur : stmt.order.includes(OUTPUT_ID) ? OUTPUT_ID : stmt.order[0]));
    setHoverCol(null);
    setPinnedCol((cur) => (cur && stmt.order.includes(cur.node) ? cur : null));
  }, [stmt]);

  const byId = useMemo(() => (stmt ? nodeMap(stmt) : null), [stmt]);
  const selected = selectedId && byId ? (byId.get(selectedId) ?? null) : null;
  const active = hoverCol ?? pinnedCol;

  const highlights: Highlights = useMemo(() => {
    if (!positionsValid || !byId) return { node: null, column: null };
    const activeNode = active ? byId.get(active.node) : undefined;
    const col = activeNode && active ? findColumn(activeNode, active.column) : null;
    return { node: selected?.span ?? null, column: opSpan ?? col?.span ?? null };
  }, [positionsValid, byId, selected, active, opSpan]);

  const selectFromUi = useCallback(
    (id: string) => {
      setSelectedId(id);
      const n = byId?.get(id);
      const span = n?.name_span ?? n?.span;
      if (span && positionsValid) setReveal({ span, nonce: ++nonce.current });
    },
    [byId, positionsValid],
  );

  // Klick på ett led i lineage-spåret: lås kolumnen, välj noden/steget och centrera vyn.
  const followColumn = useCallback(
    (c: ColumnFocus) => {
      setPinnedCol(c);
      selectFromUi(c.node);
      setFocusReq({ node: c.node, nonce: ++nonce.current });
    },
    [selectFromUi],
  );

  const onCursor = useCallback(
    (offset: number) => {
      if (!stmt || !positionsValid) return;
      const n = nodeAtOffset(stmt, offset);
      if (n) setSelectedId(n.id);
    },
    [stmt, positionsValid],
  );

  const goto = useCallback((span: Span) => setReveal({ span, nonce: ++nonce.current }), []);

  const runtimeMessage = runtime.state === "ready" ? null : runtime.message;
  const errors = latest?.ir.status === "error" ? latest.ir.errors : [];

  return (
    <div className="app">
      <header className="topbar">
        <h1>CTE VizWiz</h1>
        <label className="field">
          <span>Exempel</span>
          <select
            value=""
            onChange={(e) => {
              const s = SAMPLES.find((x) => x.id === e.target.value);
              if (s) { setSql(s.sql); setStmtIndex(0); setPinnedCol(null); setLayoutEpoch((n) => n + 1); }
            }}
          >
            <option value="" disabled>Välj…</option>
            {SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Dialekt</span>
          <select value={dialect} onChange={(e) => setDialect(e.target.value)} title="T-SQL är den dialekt som testats mest">
            {DIALECTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        {shown && shown.ir.statements.length > 1 && (
          <label className="field">
            <span>Statement</span>
            <select value={stmtIndex} onChange={(e) => setStmtIndex(Number(e.target.value))}>
              {shown.ir.statements.map((_, i) => <option key={i} value={i}>{i + 1} av {shown.ir.statements.length}</option>)}
            </select>
          </label>
        )}
        <span className="topbar__spacer" />
        <button
          type="button"
          className="tool"
          data-dbt-toggle
          aria-pressed={dbtOpen}
          aria-haspopup="dialog"
          onClick={() => setDbtOpen(!dbtOpen)}
          title="dbt: inställningar och tolkad modell"
        >
          dbt
          {latest?.ir.dbt && latest.ir.dbt.unresolved.length > 0 && <span className="badge warn">{latest.ir.dbt.unresolved.length}</span>}
        </button>
        <button type="button" className="tool" aria-pressed={showEditor} onClick={() => setShowEditor(!showEditor)} title="Visa eller dölj kodpanelen">Kod</button>
        <button type="button" className="tool" aria-pressed={wrap} onClick={() => setWrap(!wrap)} title="Bryt långa rader i stället för att scrolla i sidled">Radbrytning</button>
        <div className="seg" role="tablist" aria-label="Vy">
          <button role="tab" aria-selected={view === "flow"} className={view === "flow" ? "is-on" : ""} onClick={() => setView("flow")}>Flöde</button>
          <button role="tab" aria-selected={view === "steps"} className={view === "steps" ? "is-on" : ""} onClick={() => setView("steps")}>Steg för steg</button>
        </div>
        {dbtOpen && (
          <DbtPanel
            ir={latest?.ir ?? null}
            settings={dbtSettings}
            onChange={(s) => {
              setDbtEnabled(s.enabled);
              setIsIncremental(s.isIncremental);
              setVarsText(s.varsText);
              setMacros(s.macros);
            }}
            varsError={parsedVars.error}
            onGoto={(span) => {
              if (positionsValid) setReveal({ span, nonce: ++nonce.current });
            }}
            onClose={() => setDbtOpen(false)}
          />
        )}
      </header>

      <main className="workspace" style={{ ["--editor-w" as string]: `${editorW}px` }}>
        {showEditor && (
          <>
            <section className="pane pane--editor" aria-label="SQL">
              <EditorPane value={sql} onChange={setSql} wrap={wrap} highlights={highlights} reveal={reveal} onCursor={onCursor} />
            </section>
            <Splitter orientation="vertical" label="Bredd på kodpanelen" value={editorW} min={200} max={900} onChange={setEditorW} onReset={() => setEditorW(440)} />
          </>
        )}

        <section className="pane pane--viz" aria-label="Visualisering">
          {runtime.state !== "ready" && !stmt ? (
            <div className="empty" role="status">
              <p className="empty__title">{runtime.state === "failed" ? "Körmiljön startade inte" : runtime.message}</p>
              <p className="muted">
                {runtime.state === "failed"
                  ? "Kör `npm run prepare-runtime` i web/ och ladda om."
                  : "Python och SQLGlot laddas lokalt (cirka 10 MB). Första starten tar några sekunder."}
              </p>
            </div>
          ) : !stmt ? (
            <div className="empty" role="status">
              <p className="empty__title">{errors.length ? "Kunde inte tolka SQL" : failure ? "Analysen kraschade" : "Ingen analys än"}</p>
              {errors.map((e, i) => (
                <p key={i} className="err">
                  {e.message}
                  {e.span && <button className="linkish" onClick={() => goto(e.span!)}>rad {e.span.line}</button>}
                </p>
              ))}
              {failure && <p className="err">{failure}</p>}
            </div>
          ) : view === "flow" ? (
            <FlowView
              stmt={stmt}
              selectedId={selectedId}
              onSelect={selectFromUi}
              active={active}
              pinned={pinnedCol}
              onHoverColumn={setHoverCol}
              onPinColumn={setPinnedCol}
              onFollow={followColumn}
              hoverSpan={setOpSpan}
              resetKey={layoutEpoch}
              focusRequest={focusReq}
            />
          ) : (
            <StepView
              stmt={stmt}
              sql={shownSql}
              selectedId={selectedId}
              onSelect={selectFromUi}
              hoverSpan={setOpSpan}
              pinned={pinnedCol}
              onPinColumn={setPinnedCol}
              onFollow={followColumn}
            />
          )}
        </section>
      </main>

      <StatusBar
        ir={latest?.ir ?? null}
        stale={stale}
        busy={busy}
        runtimeMessage={failure ?? runtimeMessage}
        onGoto={goto}
      />
    </div>
  );
}
