"""Parsning med sqlglot: Jinja-detektion och felhantering som data, inte undantag."""

from __future__ import annotations

import re

import sqlglot
from sqlglot import errors as sqlglot_errors

from .spans import SourceMap

_JINJA = re.compile(r"\{\{|\{%|\{#")


def find_jinja(sql: str, sm: SourceMap):
    m = _JINJA.search(sql)
    if not m:
        return None
    return sm.span(m.start(), m.start() + 2)


def parse_sql(sql: str, dialect: str, sm: SourceMap):
    """Returnerar (statements, errors, tokens). Vid fel är statements tom."""
    try:
        d = sqlglot.Dialect.get_or_raise(dialect)
    except Exception:
        return [], [{"message": f"Okänd dialekt: {dialect}", "span": None}], []
    try:
        tokens = d.tokenize(sql)
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except sqlglot_errors.ParseError as e:
        errs = []
        for item in e.errors or [{"description": str(e)}]:
            line, col = item.get("line"), item.get("col")
            span = None
            if line and col:
                hl = item.get("highlight") or ""
                start = max(sm.offset(line, col) - len(hl), sm.offset(line, 1))
                span = sm.span(start, start + max(len(hl), 1))
            errs.append({"message": item.get("description", str(e)), "span": span})
        return [], errs, []
    except sqlglot_errors.SqlglotError as e:
        return [], [{"message": str(e), "span": None}], []
    return statements, [], tokens
