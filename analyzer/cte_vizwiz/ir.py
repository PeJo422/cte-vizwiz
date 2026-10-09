"""Hjälpare för IR:n (analysresultatet som UI:t läser).

IR:n är rena JSON-kompatibla dicts. Den innehåller aldrig radvärden, bara struktur.
"""

from __future__ import annotations

SCHEMA_VERSION = 1

OUTPUT_ID = "<output>"


def column(name, expression, change, sources=None, via_star=False, span=None):
    return {
        "name": name,
        "expression": expression,
        "change": change,
        "sources": sources or [],
        "via_star": via_star,
        "span": span,
    }


def operation(type_, expression, span=None, details=None):
    return {"type": type_, "expression": expression, "span": span, "details": details or {}}


def warning(code, message, level="warning", node=None, span=None):
    return {"code": code, "message": message, "level": level, "node": node, "span": span}


def dedupe_sources(sources):
    seen = set()
    out = []
    for s in sources:
        key = (s["node"], s["column"].lower())
        if key not in seen:
            seen.add(key)
            out.append(s)
    return out
