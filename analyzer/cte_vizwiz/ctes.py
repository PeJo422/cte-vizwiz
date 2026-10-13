"""Orkestrering: CTE-kedjan i ett statement blir noder, kanter och kolumn-lineage."""

from __future__ import annotations

from sqlglot import exp

from . import spans as sp
from .columns import Entry, Scope, STAR, arg, build_columns, table_name
from .ir import OUTPUT_ID, dedupe_sources, operation, warning
from .operations import build_operations, join_type, shape_from

_SETOP = getattr(exp, "SetOperation", exp.Union)


class SourceNode:
    """Källtabell. Kolumnerna är de som faktiskt refereras i frågan."""

    def __init__(self, name):
        self.node = {
            "id": name, "kind": "source", "span": None, "name_span": None, "body_span": None,
            "inputs": [], "operations": [], "columns": [],
            "columns_added": [], "columns_removed": [], "columns_modified": [],
            "shape": {"width_delta": None, "rows": "unknown"},
        }
        self._seen = set()

    def add_column(self, name):
        if name.lower() not in self._seen:
            self._seen.add(name.lower())
            self.node["columns"].append({
                "name": name, "expression": name, "change": "source" if name != STAR else "star_unknown",
                "sources": [], "via_star": name == STAR, "span": None,
            })


class Ctx:
    def __init__(self, dialect, sm):
        self.dialect = dialect
        self.sm = sm
        self.warnings = []
        self.statement = 0
        self.sources = {}
        self.cte_cols = {}
        self.current = None
        self._seen_warn = set()

    def warn(self, w):
        key = (self.statement, w["code"], w["message"], w["node"])
        if key not in self._seen_warn:
            self._seen_warn.add(key)
            w["statement"] = self.statement
            self.warnings.append(w)

    def source(self, name) -> SourceNode:
        key = name.lower()
        if key not in self.sources:
            self.sources[key] = SourceNode(name)
        return self.sources[key]


# ---------------------------------------------------------------- SELECT


def _unwrap(q):
    while isinstance(q, exp.Subquery):
        q = q.this
    return q


def _flatten(q, leaves, labels):
    q = _unwrap(q)
    if isinstance(q, _SETOP):
        _flatten(q.this, leaves, labels)
        labels.append("UNION ALL" if isinstance(q, exp.Union) and not q.args.get("distinct") else type(q).__name__.upper())
        _flatten(q.expression, leaves, labels)
    else:
        leaves.append(q)


def _entry_for(src, role, env, ctx, node_id):
    """Skapar scope-entry (+ ev. inputs) för ett FROM/JOIN-objekt."""
    if isinstance(src, exp.Table):
        name = table_name(src)
        if name is None:
            ctx.warn(warning("opaque_source", f"Tabellfunktion '{src.sql(dialect=ctx.dialect)}' kan inte analyseras", node=node_id))
            return Entry(src.alias_or_name or None, "opaque"), []
        alias = src.alias_or_name
        low = name.lower()
        single = "." not in name
        if single and low in env:
            c = env[low]
            return Entry(alias, "cte", c["id"], c["columns"]), [{"node": c["id"], "alias": alias}]
        if single and ctx.current and low == ctx.current:
            ctx.warn(warning("recursive_cte", f"Rekursiv CTE '{name}' stöds inte fullt ut. Kolumnerna blir okända.", node=node_id))
            return Entry(alias, "opaque"), []
        s = ctx.source(name)
        return Entry(alias, "table", s.node["id"]), [{"node": s.node["id"], "alias": alias}]
    if isinstance(src, exp.Subquery):
        alias = src.alias or None
        cols, inputs, ops, _ = analyze_query(src.this, ctx, env, node_id, None)
        ctx.warn(warning("inline_subquery", f"Inline-underfråga{' ' + alias if alias else ''} plattades ut i flödet", level="info", node=node_id))
        for o in ops:
            o["details"] = {**o["details"], "scope": alias or "underfråga"}
        entry = Entry(alias, "derived", None, cols)
        entry.inner_inputs, entry.inner_ops = inputs, ops
        return entry, None
    ctx.warn(warning("opaque_source", f"Källtyp {type(src).__name__} kan inte analyseras", node=node_id))
    return Entry(getattr(src, "alias", None) or None, "opaque"), []


def _analyze_select(select, ctx, env, node_id, clauses):
    clauses = clauses or {}
    entries, inputs, join_sources, derived_ops = [], [], [], []

    sources = []
    from_ = arg(select, "from")
    if from_ is not None:
        sources.append((from_.this, "from", None))
    for j in select.args.get("joins") or []:
        sources.append((j.this, "join", j))

    for src, role, join in sources:
        entry, ins = _entry_for(src, role, env, ctx, node_id)
        entries.append(entry)
        if ins is None:  # inline-underfråga: ärv dess inputs/operationer
            ins = [dict(i) for i in entry.inner_inputs]
            derived_ops.extend(entry.inner_ops)
            for i in ins:
                i["role"] = role
        for i in ins:
            i.setdefault("role", role)
            i.setdefault("alias", None)
            if join is not None:
                i["join_type"] = join_type(join)
                on = join.args.get("on")
                i["on"] = on.sql(dialect=ctx.dialect) if on is not None else None
            inputs.append(i)
        if join is not None:
            join_sources.append(entry.node or entry.alias)

    scope = Scope(entries)
    cols = build_columns(select, scope, ctx, node_id, clauses.get("projections", []))
    ops = build_operations(select, cols, ctx, clauses, join_sources)
    return cols, inputs, derived_ops + ops


def analyze_query(query, ctx, env, node_id, body_tokens):
    """Select eller set-operation → (columns, inputs, operations, set_op_labels)."""
    leaves, labels = [], []
    _flatten(query, leaves, labels)

    branch_clauses = [None] * len(leaves)
    if body_tokens is not None:
        try:
            branches = sp.split_branches(body_tokens)
            if len(branches) == len(leaves):
                branch_clauses = [sp.clause_spans(ctx.sm, b) for b in branches]
        except Exception:  # positioner är bonus – aldrig kritiska
            pass

    results = []
    for leaf, clauses in zip(leaves, branch_clauses):
        if not isinstance(leaf, exp.Select):
            ctx.warn(warning("unsupported_query", f"{type(leaf).__name__} stöds inte som frågekropp", node=node_id))
            results.append(([], [], []))
            continue
        results.append(_analyze_select(leaf, ctx, env, node_id, clauses))

    if len(results) == 1:
        cols, inputs, ops = results[0]
        return cols, inputs, ops, labels

    first_cols = results[0][0]
    cols = []
    for pos, c in enumerate(first_cols):
        sources, changes = list(c["sources"]), {c["change"]}
        for other in results[1:]:
            if pos < len(other[0]):
                sources.extend(other[0][pos]["sources"])
                changes.add(other[0][pos]["change"])
        cols.append({**c, "sources": dedupe_sources(sources), "change": "star_unknown" if changes == {"star_unknown"} else "merged"})
    if any(len(r[0]) != len(first_cols) for r in results[1:]):
        ctx.warn(warning("setop_width", "Grenarna i UNION/EXCEPT/INTERSECT har olika antal kolumner", node=node_id))

    inputs, ops = list(results[0][1]), list(results[0][2])
    for idx, (_, ins, branch_ops) in enumerate(results[1:], start=1):
        ops.append(operation("union", labels[idx - 1], None, {"kind": labels[idx - 1], "branch": idx}))
        for i in ins:
            inputs.append({**i, "role": "union"})
        for o in branch_ops:
            ops.append({**o, "details": {**o["details"], "branch": idx}})
    return cols, inputs, ops, labels


# ---------------------------------------------------------------- noder


def _make_node(node_id, kind, query, ctx, env, spans_, body_tokens, col_names=None):
    cols, inputs, ops, labels = analyze_query(query, ctx, env, node_id, body_tokens)
    if col_names:
        if len(col_names) == len(cols):
            for c, n in zip(cols, col_names):
                if c["name"] != n:
                    c["name"] = n
                    c["change"] = "renamed" if c["change"] == "passthrough" else c["change"]
        else:
            ctx.warn(warning("cte_column_list", f"Kolumnlistan för '{node_id}' matchar inte antalet kolumner", node=node_id))

    primary = None
    if inputs and inputs[0]["node"] in ctx.cte_cols:
        primary = ctx.cte_cols[inputs[0]["node"]]
    out_names = {c["name"].lower() for c in cols}
    if primary is not None:
        in_names = {c["name"].lower(): c["name"] for c in primary}
        added = [c["name"] for c in cols if c["name"].lower() not in in_names]
        removed = [n for low, n in in_names.items() if low not in out_names and n != STAR]
        modified = [c["name"] for c in cols if c["name"].lower() in in_names and c["change"] not in ("passthrough", "star_unknown")]
        width_delta = len(cols) - len(primary)
    else:
        added, removed, modified, width_delta = [], [], [], None

    return {
        "id": node_id, "kind": kind,
        "span": spans_.get("span"), "name_span": spans_.get("name_span"), "body_span": spans_.get("body_span"),
        "inputs": inputs, "operations": ops, "columns": cols,
        "columns_added": added, "columns_removed": removed, "columns_modified": modified,
        "shape": {"width_delta": width_delta, "rows": shape_from(ops, labels)},
    }


def _find_query(stmt):
    if isinstance(stmt, exp.Query):
        return stmt, True
    inner = stmt.args.get("expression")
    if isinstance(inner, exp.Query):
        return inner, False
    return None, False


def analyze_statement(stmt, chunk, ctx: Ctx, index: int):
    ctx.statement = index
    ctx.sources, ctx.cte_cols, ctx.current = {}, {}, None

    query, top_level = _find_query(stmt)
    if query is None:
        return None
    with_ = arg(query, "with")
    cte_asts = with_.expressions if with_ is not None else []

    located = None
    if chunk is not None and top_level:
        located = sp.locate_ctes(chunk)
        if located is None or len(located[0]) != len(cte_asts):
            ctx.warn(warning("spans_unavailable", "Källpositioner kunde inte bestämmas för detta statement", level="info"))
            located = None
    elif chunk is not None and not top_level:
        ctx.warn(warning("spans_unavailable", "Källpositioner saknas för CTE:er i INSERT/CREATE", level="info"))

    if with_ is not None and with_.args.get("recursive"):
        ctx.warn(warning("recursive_cte", "WITH RECURSIVE stöds inte fullt ut", node=None))

    env, nodes = {}, []
    for n, cte in enumerate(cte_asts):
        alias = cte.args.get("alias")
        name = cte.alias
        col_names = [c.name for c in alias.args.get("columns") or []] if alias is not None else []
        spans_, body_tokens = {}, None
        if located:
            info = located[0][n]
            spans_ = {
                "span": sp.tok_span(ctx.sm, chunk, info["name_idx"], info["close_idx"]),
                "name_span": sp.tok_span(ctx.sm, chunk, info["name_idx"], info["name_idx"]),
                "body_span": sp.tok_span(ctx.sm, chunk, info["open_idx"] + 1, info["close_idx"] - 1)
                if info["close_idx"] - info["open_idx"] > 1 else None,
            }
            body_tokens = chunk[info["open_idx"] + 1: info["close_idx"]]
        ctx.current = name.lower()
        node = _make_node(name, "cte", cte.this, ctx, env, spans_, body_tokens, col_names)
        ctx.current = None
        env[name.lower()] = {"id": name, "columns": node["columns"]}
        ctx.cte_cols[name] = node["columns"]
        nodes.append(node)

    out_spans, out_tokens = {}, None
    if located is not None and located[1] < len(chunk):
        out_tokens = chunk[located[1]:]
        out_spans = {"span": sp.tok_span(ctx.sm, chunk, located[1], len(chunk) - 1)}
        out_spans["body_span"] = dict(out_spans["span"])  # egen kopia: spans muteras vid dbt-omräkning
    out = _make_node(OUTPUT_ID, "output", query, ctx, env, out_spans, out_tokens)
    nodes.append(out)

    source_nodes = [s.node for s in ctx.sources.values()]
    all_nodes = source_nodes + nodes
    edges, seen = [], set()
    for node in all_nodes:
        for i in node["inputs"]:
            key = (i["node"], node["id"], i["role"], i.get("alias"))
            if key not in seen:
                seen.add(key)
                edges.append({"from": i["node"], "to": node["id"], "role": i["role"], "join_type": i.get("join_type")})

    return {
        "index": index,
        "span": sp.tok_span(ctx.sm, chunk, 0, len(chunk) - 1) if chunk else None,
        "nodes": all_nodes,
        "edges": edges,
        "output_node": OUTPUT_ID,
        "order": [n["id"] for n in all_nodes],
    }
