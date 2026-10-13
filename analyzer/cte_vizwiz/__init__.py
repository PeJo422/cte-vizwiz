"""CTE VizWiz – statisk analys av SQL med CTE:er.

analyze(sql, dialect, options) → IR (JSON-kompatibel dict). Ingen databas, inga radvärden.

options (alla frivilliga):
  dbt            True (standard) = rendera dbt-Jinja när `{{ }}`/`{% %}` finns, False = behandla som ren SQL
  vars           {namn: värde} för var()
  macros         text med `{% macro %}`-definitioner som modellen får använda
  is_incremental True/False för is_incremental() (standard False = full körning)
"""

from __future__ import annotations

from . import dbt
from . import spans as sp
from .ctes import Ctx, analyze_statement
from .ir import SCHEMA_VERSION, warning
from .parse import find_jinja, parse_sql


def analyze(sql: str, dialect: str = "tsql", options: dict | None = None) -> dict:
    options = options or {}
    sm_orig = sp.SourceMap(sql)

    rendered = None
    work = sql
    if options.get("dbt", True) and dbt.looks_like_jinja(sql):
        rendered = dbt.render(sql, dialect, options, sm_orig)
        if rendered.error:
            return _render_failed(dialect, rendered)
        work = rendered.sql

    result = _analyze_text(work, dialect, with_jinja_warning=rendered is None)
    result["dbt"] = None
    if rendered is not None:
        dbt.finalize(result, rendered, sm_orig, options)
    elif result["status"] != "error":
        for st in result["statements"]:
            for n in st["nodes"]:
                n["dbt"] = None

    if result["status"] != "error":
        result["status"] = "partial" if any(w["level"] == "warning" for w in result["warnings"]) else "ok"
    return result


def _render_failed(dialect: str, rendered: dbt.Rendered) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "dialect": dialect,
        "status": "error",
        "warnings": [],
        "errors": [rendered.error],
        "statements": [],
        "dbt": None,
    }


def _analyze_text(sql: str, dialect: str, with_jinja_warning: bool) -> dict:
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

    jinja = find_jinja(sql, sm) if with_jinja_warning else None
    if jinja:
        ctx.warn(warning(
            "jinja",
            "Jinja hittades men dbt-läget är avstängt. Resultatet är ofullständigt.",
            span=jinja,
        ))

    statements, errors, tokens = parse_sql(sql, dialect, sm)
    if errors:
        if jinja:
            errors = [{"message": "Parsningen misslyckades. Troligen beror det på Jinja, och dbt-läget är avstängt.", "span": jinja}] + errors
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
    return result
