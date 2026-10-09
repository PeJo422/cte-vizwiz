"""Scope, kolumnupplösning och kolumn-lineage för en enskild SELECT."""

from __future__ import annotations

from sqlglot import exp

from .ir import column, dedupe_sources, warning

STAR = "*"


def arg(node, key):
    """Läs ett AST-argument oavsett om sqlglot-versionen kallar det 'from' eller 'from_'."""
    v = node.args.get(key)
    return v if v is not None else node.args.get(key + "_")


def walk(expr):
    """Besök alla noder utan att gå ner i nästlade frågor (de besöks men expanderas inte)."""
    yield expr
    for child in expr.iter_expressions():
        if isinstance(child, exp.Query):
            yield child
            continue
        yield from walk(child)


def table_name(table: exp.Table):
    """Fullt kvalificerat namn, eller None om 'tabellen' inte är en vanlig relation."""
    if not isinstance(table.this, exp.Identifier):
        return None
    return ".".join(p.name for p in table.parts if p is not None and getattr(p, "name", ""))


class Entry:
    """En relation i FROM/JOIN: CTE, källtabell, inline-underfråga eller okänd."""

    def __init__(self, alias, kind, node=None, columns=None):
        self.alias = alias
        self.kind = kind  # cte | table | derived | opaque
        self.node = node
        self.columns = columns  # None = okända kolumner, annars lista av kolumn-dicts
        self._by_lower = {c["name"].lower(): c for c in columns} if columns else {}

    @property
    def partially_unknown(self):
        return self.columns is None or STAR in self._by_lower

    def has(self, name):
        return name.lower() in self._by_lower

    def ref(self, name, ctx):
        if self.kind == "table":
            ctx.source(self.node).add_column(name)
            return [{"node": self.node, "column": name}]
        if self.kind == "cte":
            c = self._by_lower.get(name.lower())
            return [{"node": self.node, "column": c["name"] if c else name}]
        if self.kind == "derived":
            c = self._by_lower.get(name.lower())
            return list(c["sources"]) if c else []
        return []


class Scope:
    def __init__(self, entries):
        self.entries = entries

    def by_alias(self, alias):
        a = alias.lower()
        for e in self.entries:
            if e.alias and e.alias.lower() == a:
                return e
        return None


def resolve_column(col: exp.Column, scope: Scope, ctx, node_id):
    name = col.name
    if not name:
        return []
    if col.table:
        e = scope.by_alias(col.table)
        if e is None:
            ctx.warn(warning("unresolved_qualifier", f"Okänd tabell/alias '{col.table}' för kolumnen {col.sql()}", node=node_id))
            return []
        return e.ref(name, ctx)
    known = [e for e in scope.entries if e.has(name)]
    unknown = [e for e in scope.entries if e.partially_unknown and not e.has(name)]
    candidates = known + unknown
    if len(candidates) == 1:
        return candidates[0].ref(name, ctx)
    if not candidates:
        if scope.entries:
            ctx.warn(warning("column_not_found", f"Kolumnen '{name}' hittades inte i någon källa", node=node_id))
        return []
    ctx.warn(warning("ambiguous_column", f"Kolumnen '{name}' kan komma från flera källor ({', '.join(e.alias or '?' for e in candidates)})", node=node_id))
    return []


def _classify(inner, name, refs, has_sub=False):
    if any(isinstance(n, exp.Window) for n in walk(inner)):
        return "window"
    if any(isinstance(n, exp.AggFunc) for n in walk(inner)):
        return "aggregate"
    if isinstance(inner, exp.Column):
        return "passthrough" if inner.name.lower() == name.lower() else "renamed"
    if not refs and not has_sub:
        return "literal"
    return "derived"


def expand_star(entry: Entry, ctx, node_id, span):
    """Kolumner som `*` / `alias.*` ger för en relation, i källans ordning."""
    if entry.kind == "opaque":
        ctx.warn(warning("opaque_source", f"Kolumnerna från '{entry.alias}' kan inte härledas", node=node_id, span=span))
        return []
    cols = []
    for c in entry.columns if entry.columns is not None else [{"name": STAR}]:
        if c["name"] != STAR:
            cols.append(column(c["name"], c["name"], "passthrough", entry.ref(c["name"], ctx), True, span))
            continue
        if entry.kind == "table":
            ctx.source(entry.node).add_column(STAR)
            ctx.warn(warning(
                "star_unknown",
                f"SELECT * mot '{entry.alias or entry.node}' – kolumnerna är okända utan schema",
                level="info", node=node_id, span=span,
            ))
        sources = [{"node": entry.node, "column": STAR}] if entry.node else []
        cols.append(column(STAR, f"{entry.alias}.*" if entry.alias else "*", "star_unknown", sources, True, span))
    return cols


def build_columns(select: exp.Select, scope: Scope, ctx, node_id, proj_spans):
    """Projektionerna i en SELECT som kolumn-dicts med lineage."""
    cols = []
    aligned = len(proj_spans) == len(select.expressions)
    for i, p in enumerate(select.expressions):
        span = proj_spans[i] if aligned else None
        inner = p.this if isinstance(p, exp.Alias) else p

        if isinstance(inner, exp.Star):
            for e in scope.entries:
                cols.extend(expand_star(e, ctx, node_id, span))
            continue
        if isinstance(inner, exp.Column) and isinstance(inner.this, exp.Star):
            e = scope.by_alias(inner.table) if inner.table else None
            if e is None:
                ctx.warn(warning("unresolved_qualifier", f"Okänd tabell/alias '{inner.table}' i {inner.sql()}", node=node_id, span=span))
            else:
                cols.extend(expand_star(e, ctx, node_id, span))
            continue

        name = p.alias if isinstance(p, exp.Alias) else inner.output_name
        if not name:
            name = inner.sql(dialect=ctx.dialect)
        refs, has_sub, sources = [], False, []
        for n in walk(inner):
            if isinstance(n, exp.Query):
                has_sub = True
            elif isinstance(n, exp.Column) and not isinstance(n.this, exp.Star):
                refs.append(n)
        for r in refs:
            sources.extend(resolve_column(r, scope, ctx, node_id))
        if has_sub:
            ctx.warn(warning("subquery_in_expression", f"Underfråga i uttrycket för '{name}' expanderas inte", node=node_id, span=span))
        cols.append(column(name, inner.sql(dialect=ctx.dialect), _classify(inner, name, refs, has_sub), dedupe_sources(sources), False, span))
    return cols
