"""CTE VizWiz – statisk analys av SQL med CTE:er.

analyze(sql, dialect) → IR (JSON-kompatibel dict). Ingen databas, inga radvärden.
"""

from __future__ import annotations

from . import spans as sp
from .ctes import Ctx, analyze_statement
from .ir import SCHEMA_VERSION, warning
from .parse import find_jinja, parse_sql


def analyze(sql: str, dialect: str = "tsql") -> dict:
    sm = sp.SourceMap(sql)
    ctx = Ctx(dialect, sm)
    result = {
        "schema_version": SCHEMA_VERSION,
        "dialect": dialect,
        "status": "ok",
        "warnings": ctx.warnings,
        "errors": [],
        "statements": [],
    }

    jinja = find_jinja(sql, sm)
    if jinja:
        ctx.warn(warning(
            "jinja",
            "Jinja/dbt-templating hittades. MVP:n tolkar bara ren SQL – resultatet är ofullständigt.",
            span=jinja,
        ))

    statements, errors, tokens = parse_sql(sql, dialect, sm)
    if errors:
        if jinja:
            errors = [{"message": "Parsningen misslyckades, troligen på grund av Jinja/dbt-templating (ej stött i MVP:n).", "span": jinja}] + errors
        result["errors"] = errors
        result["status"] = "error"
        return result

    chunks = sp.split_statements(tokens)
    aligned = len(chunks) == len(statements)
    if not aligned:
        ctx.warn(warning("spans_unavailable", "Källpositioner kunde inte matchas mot statements", level="info"))

    for i, stmt in enumerate(statements):
        s = analyze_statement(stmt, chunks[i] if aligned else None, ctx, i)
        if s is not None:
            result["statements"].append(s)

    if not result["statements"]:
        result["status"] = "error"
        result["errors"] = [{"message": "Ingen SELECT/CTE hittades att visualisera.", "span": None}]
    elif any(w["level"] == "warning" for w in ctx.warnings):
        result["status"] = "partial"
    return result
