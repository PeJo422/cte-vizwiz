import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Column, IrNode, Span, Statement } from "../ir";
import { CHANGE_LABEL, DBT_KIND_LABEL, OP_LABEL, ROWS_LABEL, dbtLabel, widthSummary } from "../lib/explain";
import { CARD_W, layoutNodes, visibleOps } from "../lib/layout";
import { traceLineage, type Lineage } from "../lib/lineage";
import { colKey, displayName, findColumn, nodeMap, sameColumn, type ColumnFocus } from "../lib/model";
import { isBoolean, isNumber, usePersistentState } from "../lib/persist";
import { LineageTrail } from "./LineageTrail";
import { OperationList } from "./OperationList";
import { Splitter } from "./Splitter";

export type { ColumnFocus };

interface FlowCtxValue {
  selectedId: string | null;
  active: ColumnFocus | null;
  pinned: ColumnFocus | null;
  lineage: Lineage | null;
  onHover: (c: ColumnFocus | null) => void;
  onPin: (c: ColumnFocus) => void;
}

const FlowCtx = createContext<FlowCtxValue | null>(null);

type CardNode = Node<{ node: IrNode }, "cte">;

const KIND_LABEL = { source: "Källtabell", cte: "CTE", output: "Resultat" } as const;

function markFor(node: IrNode, c: Column): string {
  if (c.change === "star_unknown") return "*";
  if (c.change === "unresolved") return "?";
  if (node.columns_added.includes(c.name)) return "+";
  if (node.columns_modified.includes(c.name)) return "~";
  return "";
}

function CteCard({ id, data }: NodeProps<CardNode>) {
  const ctx = useContext(FlowCtx)!;
  const { node } = data;
  const updateInternals = useUpdateNodeInternals();
  const signature = node.columns.map((c) => c.name).join("|");
  useEffect(() => updateInternals(id), [id, signature, updateInternals]);

  const ops = visibleOps(node);
  const width = widthSummary(node);
  return (
    <div className={`cte-card kind-${node.kind}${ctx.selectedId === id ? " is-selected" : ""}`} style={{ width: CARD_W }}>
      <div className="cte-card__head" title="Dra i kortet för att flytta det">
        <Handle id="in" type="target" position={Position.Left} isConnectable={false} />
        <span className={`cte-card__kind${node.dbt ? " is-dbt" : ""}`} title={node.dbt ? dbtLabel(node.dbt) : undefined}>
          {node.dbt ? DBT_KIND_LABEL[node.dbt.kind] : KIND_LABEL[node.kind]}
        </span>
        <span className="cte-card__name" title={node.id}>{displayName(node.id)}</span>
        <Handle id="out" type="source" position={Position.Right} isConnectable={false} />
      </div>

      {ops.length > 0 && (
        <ul className="cte-card__ops">
          {ops.map((op, i) => (
            <li key={i} title={op.expression}>
              <span className={`chip chip-${op.type}`}>{op.details.clause === "HAVING" ? "HAVING" : OP_LABEL[op.type]}</span>
              <span className="cte-card__opexpr">{op.expression}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="cte-card__cols">
        {node.columns.map((c) => {
          const focus: ColumnFocus = { node: id, column: c.name };
          const key = colKey(id, c.name);
          const isActive = sameColumn(ctx.active, focus);
          const isPinned = sameColumn(ctx.pinned, focus);
          const inLineage = ctx.lineage?.cols.has(key) ?? false;
          const dim = ctx.lineage !== null && !inLineage;
          const from = c.sources.map((s) => `${displayName(s.node)}.${s.column}`).join(", ");
          const toggle = (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            ctx.onPin(focus);
          };
          const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle(e);
            }
          };
          return (
            <li
              key={c.name}
              role="button"
              tabIndex={0}
              aria-pressed={isPinned}
              aria-label={`${c.name}, ${CHANGE_LABEL[c.change]}. ${isPinned ? "Släpp lineage" : "Följ lineage"}`}
              className={`col change-${c.change}${node.columns_added.includes(c.name) ? " is-new" : ""}${isActive ? " is-active" : ""}${isPinned ? " is-pinned" : ""}${inLineage ? " in-lineage" : ""}${dim ? " is-dim" : ""}`}
              title={`${c.expression}\n${CHANGE_LABEL[c.change]}${from ? `\nfrån: ${from}` : ""}\n\nKlicka för att följa lineage`}
              onMouseEnter={() => ctx.onHover(focus)}
              onMouseLeave={() => ctx.onHover(null)}
              onFocus={() => ctx.onHover(focus)}
              onBlur={() => ctx.onHover(null)}
              onClick={toggle}
              onKeyDown={onKey}
            >
              <Handle id={`in:${c.name}`} type="target" position={Position.Left} isConnectable={false} className="row-handle" />
              <span className="col__mark" aria-hidden="true">{markFor(node, c)}</span>
              <span className="col__name">{c.name === "*" ? "* (okända kolumner)" : c.name}</span>
              {node.kind !== "source" && c.change !== "passthrough" && (
                <span className="col__tag">{c.change === "star_unknown" || c.change === "unresolved" ? "okänd" : CHANGE_LABEL[c.change]}</span>
              )}
              <Handle id={`out:${c.name}`} type="source" position={Position.Right} isConnectable={false} className="row-handle" />
            </li>
          );
        })}
      </ul>

      {node.columns_removed.length > 0 && (
        <div className="cte-card__removed">
          <div className="cte-card__removed-head">Borttagna kolumner</div>
          <ul>
            {node.columns_removed.map((n) => (
              <li key={n} className="col is-removed">
                <span className="col__mark" aria-hidden="true">−</span>
                <span className="col__name">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {node.kind !== "source" && (
        <div className="cte-card__foot">
          <span>{ROWS_LABEL[node.shape.rows]}</span>
          {width && <span>{width}</span>}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { cte: CteCard };

export interface FocusRequest {
  node: string;
  nonce: number;
}

interface Props {
  stmt: Statement;
  selectedId: string | null;
  onSelect: (id: string) => void;
  active: ColumnFocus | null;
  pinned: ColumnFocus | null;
  onHoverColumn: (c: ColumnFocus | null) => void;
  onPinColumn: (c: ColumnFocus | null) => void;
  /** Följ lineage till ett annat led: välj noden, lås kolumnen och centrera vyn. */
  onFollow: (c: ColumnFocus) => void;
  hoverSpan: (span: Span | null) => void;
  /** Ändras när layouten ska börja om (t.ex. nytt exempel). */
  resetKey: number;
  focusRequest: FocusRequest | null;
}

const buildNode = (n: IrNode, position: { x: number; y: number }): CardNode => ({
  id: n.id,
  type: "cte",
  position,
  data: { node: n },
  draggable: true,
});

function Inner({ stmt, selectedId, onSelect, active, pinned, onHoverColumn, onPinColumn, onFollow, hoverSpan, resetKey, focusRequest }: Props) {
  const { fitView, setCenter, getZoom, getInternalNode } = useReactFlow();
  const defaults = useMemo(() => layoutNodes(stmt), [stmt]);
  const lineage = useMemo(() => (active ? traceLineage(stmt, active.node, active.column) : null), [stmt, active]);
  const byId = useMemo(() => nodeMap(stmt), [stmt]);

  // `nodes` är riktig state och alla ändringar går genom applyNodeChanges. Bygger man i stället
  // om arrayen vid varje drag tappar React Flow nodernas uppmätta mått och döljer korten
  // (visibility: hidden) tills de mätts om – det syntes som blinkningar under dragning.
  const [nodes, setNodes] = useState<CardNode[]>(() => stmt.nodes.map((n) => buildNode(n, defaults.get(n.id) ?? { x: 0, y: 0 })));
  const moved = useRef(new Set<string>()); // kort användaren dragit – de behåller sin plats
  const [movedCount, setMovedCount] = useState(0);
  const lastReset = useRef(resetKey);

  useEffect(() => {
    if (lastReset.current !== resetKey) {
      lastReset.current = resetKey;
      moved.current.clear();
    }
    const ids = new Set(stmt.order);
    for (const id of moved.current) if (!ids.has(id)) moved.current.delete(id);
    setMovedCount(moved.current.size);
    setNodes((prev) => {
      const old = new Map(prev.map((p) => [p.id, p]));
      return stmt.nodes.map((n) => {
        const def = defaults.get(n.id) ?? { x: 0, y: 0 };
        const cur = old.get(n.id);
        // behåll objektet (och därmed measured) – byt bara data och, för ej flyttade kort, position
        return cur ? { ...cur, data: { node: n }, position: moved.current.has(n.id) ? cur.position : def } : buildNode(n, def);
      });
    });
  }, [stmt, defaults, resetKey]);

  const onNodesChange = useCallback((changes: NodeChange<CardNode>[]) => {
    let added = false;
    for (const c of changes) {
      if (c.type === "position" && c.position && !moved.current.has(c.id)) {
        moved.current.add(c.id);
        added = true;
      }
    }
    if (added) setMovedCount(moved.current.size);
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);

  const edges: Edge[] = useMemo(() => {
    const tableEdges: Edge[] = stmt.edges.map((e, i) => ({
      id: `t${i}:${e.from}>${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle: "out",
      targetHandle: "in",
      label: e.role === "join" ? (e.join_type ?? "JOIN") : e.role === "union" ? "UNION" : undefined,
      className: `table-edge role-${e.role}${lineage ? " is-dim" : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    }));
    if (!lineage) return tableEdges;
    const colEdges: Edge[] = lineage.edges.flatMap((e, i) => {
      const from = byId.get(e.fromNode);
      const to = byId.get(e.toNode);
      if (!from || !to || !findColumn(from, e.fromCol) || !findColumn(to, e.toCol)) return [];
      return [{
        id: `c${i}`,
        source: e.fromNode,
        target: e.toNode,
        sourceHandle: `out:${e.fromCol}`,
        targetHandle: `in:${e.toCol}`,
        className: "lineage-edge",
        animated: true,
        zIndex: 10,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      } satisfies Edge];
    });
    return [...tableEdges, ...colEdges];
  }, [stmt, lineage, byId]);

  const ctx: FlowCtxValue = useMemo(
    () => ({
      selectedId,
      active,
      pinned,
      lineage,
      onHover: onHoverColumn,
      onPin: (c) => onPinColumn(sameColumn(pinned, c) ? null : c),
    }),
    [selectedId, active, pinned, lineage, onHoverColumn, onPinColumn],
  );

  // Anpassa vyn när kortens form ändras (inte vid varje drag).
  const layoutSignature = stmt.nodes.map((n) => `${n.id}:${n.columns.length}`).join(",");
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.15, duration: 250, maxZoom: 1 }), 60);
    return () => clearTimeout(t);
  }, [layoutSignature, resetKey, fitView]);

  // Centrera på noden när man följer lineage dit.
  useEffect(() => {
    if (!focusRequest) return;
    const n = getInternalNode(focusRequest.node);
    if (!n) return;
    const w = n.measured.width ?? CARD_W;
    const h = n.measured.height ?? 160;
    void setCenter(n.internals.positionAbsolute.x + w / 2, n.internals.positionAbsolute.y + h / 2, {
      zoom: Math.max(getZoom(), 0.7),
      duration: 350,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bara när en ny förfrågan kommer
  }, [focusRequest]);

  const resetLayout = () => {
    moved.current.clear();
    setMovedCount(0);
    setNodes((prev) => prev.map((p) => ({ ...p, position: defaults.get(p.id) ?? p.position })));
    setTimeout(() => fitView({ padding: 0.15, duration: 250, maxZoom: 1 }), 30);
  };

  const [detailsOpen, setDetailsOpen] = usePersistentState("details-open", true, isBoolean);
  const [detailsH, setDetailsH] = usePersistentState("details-h", 220, isNumber);

  const selectedNode = selectedId ? byId.get(selectedId) : undefined;
  const shown = pinned ?? active;
  const shownNode = shown ? byId.get(shown.node) : undefined;
  const shownColumn = shownNode && shown ? findColumn(shownNode, shown.column) : null;

  return (
    <div className="flow">
      <div className="flow__canvas">
        <FlowCtx.Provider value={ctx}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            nodesConnectable={false}
            nodesDraggable
            minZoom={0.15}
            maxZoom={1.6}
            onNodeClick={(_, n) => onSelect(n.id)}
            onPaneClick={() => onPinColumn(null)}
            aria-label="Diagram över CTE:erna. Kort kan dras."
          >
            <Background gap={22} />
            <Controls showInteractive={false} />
            <Panel position="top-right" className="flow__tools">
              <button type="button" onClick={() => fitView({ padding: 0.15, duration: 250, maxZoom: 1 })}>Anpassa vy</button>
              <button type="button" onClick={resetLayout} disabled={movedCount === 0} title="Återgå till automatisk placering">Återställ layout</button>
            </Panel>
          </ReactFlow>
        </FlowCtx.Provider>
        {!pinned && <p className="flow__hint">Dra för att flytta kort. Klicka på en kolumn för att följa lineage.</p>}
      </div>

      {detailsOpen && (
        <Splitter orientation="horizontal" invert label="Höjd på detaljpanelen" value={detailsH} min={72} max={640} onChange={setDetailsH} onReset={() => setDetailsH(220)} />
      )}
      <aside className="details" style={detailsOpen ? { height: detailsH } : undefined} aria-live="polite">
        <div className="details__bar">
          <h2>
            {selectedNode ? displayName(selectedNode.id) : "Detaljer"}
            {selectedNode && selectedNode.kind !== "output" && (
              <small>{selectedNode.dbt ? DBT_KIND_LABEL[selectedNode.dbt.kind] : KIND_LABEL[selectedNode.kind]}</small>
            )}
          </h2>
          <button type="button" className="icon-btn" onClick={() => setDetailsOpen(!detailsOpen)} aria-expanded={detailsOpen} title={detailsOpen ? "Fäll ihop detaljer" : "Visa detaljer"}>
            <span className={`chevron ${detailsOpen ? "is-down" : "is-up"}`} aria-hidden="true" />
          </button>
        </div>
        {detailsOpen && (
          <div className="details__body">
            {selectedNode ? (
              <>
                {pinned && <LineageTrail stmt={stmt} focus={pinned} onFollow={onFollow} onClear={() => onPinColumn(null)} />}
                {selectedNode.dbt && (
                  <p className="details__dbt">
                    <span className="muted">Kommer från</span> <code>{dbtLabel(selectedNode.dbt)}</code>
                  </p>
                )}
                {selectedNode.kind !== "source" && <OperationList node={selectedNode} onHover={hoverSpan} />}
                {shown && shownColumn && (
                  <div className="details__col">
                    <h3>Kolumn: {shownColumn.name}</h3>
                    <p>
                      <span className={`tag tag-${shownColumn.change}`}>{CHANGE_LABEL[shownColumn.change]}</span>{" "}
                      <code>{shownColumn.expression}</code>
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="muted">Välj en CTE i diagrammet eller klicka i koden.</p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

export function FlowView(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
