"""Operationer (filter, join, aggregate ...) och kvalitativ form (shape) för en SELECT."""

from __future__ import annotations

from sqlglot import exp

from .columns import arg, walk
from .ir import operation


def join_type(join: exp.Join) -> str:
    parts = [join.args.get("method"), join.args.get("side"), join.args.get("kind")]
    label = " ".join(p for p in parts if p).upper()
    return label or "INNER"


def build_operations(select: exp.Select, columns, ctx, clause_spans, join_sources):
    """Operationer i källordning. join_sources[i] = (alias/nodnamn) för i:te JOIN."""
    d = ctx.dialect
    spans = clause_spans or {}
    ops = []

    names = ", ".join(c["expression"] for c in columns)
    ops.append(operation("select", names if len(names) <= 200 else names[:197] + "...", spans.get("select")))

    joins = select.args.get("joins") or []
    for i, j in enumerate(joins):
        on = j.args.get("on")
        using = j.args.get("using")
        ops.append(operation(
            "join", j.sql(dialect=d),
            spans.get("joins", [])[i] if len(spans.get("joins", [])) == len(joins) else None,
            {
                "join_type": join_type(j),
                "source": join_sources[i] if i < len(join_sources) else None,
                "on": on.sql(dialect=d) if on is not None else None,
                "using": [u.sql(dialect=d) for u in using] if using else None,
            },
        ))

    where = arg(select, "where")
    if where is not None:
        ops.append(operation("filter", where.this.sql(dialect=d), spans.get("where"), {"clause": "WHERE"}))

    group = select.args.get("group")
    has_agg = any(c["change"] == "aggregate" for c in columns)
    having = select.args.get("having")
    if group is not None or has_agg or having is not None:
        keys = [e.sql(dialect=d) for e in (group.expressions if group is not None else [])]
        ops.append(operation(
            "aggregate",
            ("GROUP BY " + ", ".join(keys)) if keys else "aggregat utan GROUP BY",
            spans.get("group"),
            {"group_by": keys},
        ))
        if having is not None:
            ops.append(operation("filter", having.this.sql(dialect=d), spans.get("having"), {"clause": "HAVING"}))

    qualify = select.args.get("qualify")
    if qualify is not None:
        ops.append(operation("filter", qualify.this.sql(dialect=d), spans.get("qualify"), {"clause": "QUALIFY"}))

    if select.args.get("distinct"):
        ops.append(operation("distinct", "DISTINCT", spans.get("select")))

    wins = {n.sql(dialect=d) for e in select.expressions for n in walk(e) if isinstance(n, exp.Window)}
    if wins:
        ops.append(operation("window", "; ".join(sorted(wins)), spans.get("select")))

    order = select.args.get("order")
    if order is not None:
        ops.append(operation("order", ", ".join(e.sql(dialect=d) for e in order.expressions), spans.get("order")))

    limit = select.args.get("limit")
    if limit is not None:
        text = limit.expression.sql(dialect=d) if limit.expression is not None else limit.sql(dialect=d)
        ops.append(operation("limit", ("TOP " if d == "tsql" else "LIMIT ") + text, spans.get("select")))
    return ops


def shape_from(ops, set_ops=()):
    """Kvalitativ radeffekt (inga siffror, ingen data)."""
    types = {o["type"] for o in ops}
    join_types = {o["details"].get("join_type") for o in ops if o["type"] == "join"}
    if "aggregate" in types:
        rows = "collapsed"
    elif "join" in types:
        rows = "more" if join_types and join_types <= {"CROSS"} else "unknown"
    elif types & {"filter", "distinct", "limit"}:
        rows = "fewer"
    else:
        rows = "same"
    if set_ops:
        if rows == "same" and all(s == "UNION ALL" for s in set_ops):
            rows = "more"
        elif rows in ("same", "fewer"):
            rows = "unknown"
    return rows
