"""Källpositioner via sqlglot-tokenizern.

Tokenizern hanterar strängar, kommentarer och citerade identifierare, så
parentesmatchning på tokens är betydligt säkrare än regex på texten.
Alla funktioner returnerar None / tom struktur om något inte stämmer, så att
analysen kan fortsätta utan positioner i stället för att krascha.
"""

from __future__ import annotations

import re
from bisect import bisect_right

from sqlglot.tokens import TokenType as T

_SET_OPS = {T.UNION, T.EXCEPT, T.INTERSECT}
_JOIN_MODIFIERS = {
    t for t in (
        getattr(T, n, None)
        for n in ("LEFT", "RIGHT", "FULL", "INNER", "CROSS", "OUTER", "NATURAL", "SEMI", "ANTI")
    ) if t is not None
}
_CLAUSES = {
    T.SELECT: "select",
    T.FROM: "from",
    T.WHERE: "where",
    T.GROUP_BY: "group",
    T.HAVING: "having",
    T.ORDER_BY: "order",
    T.QUALIFY: "qualify",
    T.JOIN: "join",
}
_APPLY = getattr(T, "APPLY", None)
if _APPLY is not None:
    _CLAUSES[_APPLY] = "join"


class SourceMap:
    def __init__(self, sql: str):
        self.starts = [0] + [m.end() for m in re.finditer(r"\n", sql)]

    def span(self, start: int, end: int) -> dict:
        """Halvöppet intervall [start, end); rad/kolumn är 1-baserade."""
        last = max(end - 1, start)
        l1 = bisect_right(self.starts, start) - 1
        l2 = bisect_right(self.starts, last) - 1
        return {
            "start": start,
            "end": end,
            "line": l1 + 1,
            "col": start - self.starts[l1] + 1,
            "end_line": l2 + 1,
            "end_col": end - self.starts[l2] + 1,
        }

    def offset(self, line: int, col: int) -> int:
        line = max(1, min(line, len(self.starts)))
        return self.starts[line - 1] + max(col - 1, 0)


def tok_span(sm: SourceMap, toks, a: int, b: int) -> dict:
    """Span över token a..b (inklusive)."""
    return sm.span(toks[a].start, toks[b].end + 1)


def split_statements(tokens):
    chunks, cur = [], []
    for t in tokens:
        if t.token_type == T.SEMICOLON:
            if cur:
                chunks.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        chunks.append(cur)
    return chunks


def match_paren(toks, open_idx):
    depth = 0
    for i in range(open_idx, len(toks)):
        tt = toks[i].token_type
        if tt == T.L_PAREN:
            depth += 1
        elif tt == T.R_PAREN:
            depth -= 1
            if depth == 0:
                return i
    raise IndexError("omatchad parentes")


def locate_ctes(chunk):
    """Hitta CTE:erna i en statement-chunk.

    Returnerar (ctes, main_start) där ctes är [{name_idx, open_idx, close_idx}]
    och main_start är index för huvudfrågans första token. None vid avvikelse.
    """
    try:
        if not chunk or chunk[0].token_type != T.WITH:
            return [], 0
        i = 1
        if chunk[i].text.upper() == "RECURSIVE":
            i += 1
        ctes = []
        while True:
            name_idx = i
            j = i + 1
            if chunk[j].token_type == T.L_PAREN:  # kolumnlista: name (a, b) AS (...)
                j = match_paren(chunk, j) + 1
            if chunk[j].token_type != T.ALIAS:  # AS
                return None
            open_idx = j + 1
            if chunk[open_idx].token_type != T.L_PAREN:
                return None
            close_idx = match_paren(chunk, open_idx)
            ctes.append({"name_idx": name_idx, "open_idx": open_idx, "close_idx": close_idx})
            k = close_idx + 1
            if k < len(chunk) and chunk[k].token_type == T.COMMA:
                i = k + 1
                continue
            return ctes, k
    except IndexError:
        return None


def split_branches(toks):
    """Dela en frågekropp vid UNION/EXCEPT/INTERSECT på djup 0."""
    branches, cur, depth = [], [], 0
    for t in toks:
        tt = t.token_type
        if tt == T.L_PAREN:
            depth += 1
        elif tt == T.R_PAREN:
            depth -= 1
        if depth == 0 and tt in _SET_OPS:
            branches.append(cur)
            cur = []
            continue
        cur.append(t)
    branches.append(cur)
    cleaned = []
    for b in branches:
        # hoppa över ALL/DISTINCT som följer direkt efter set-operatorn
        while b and b[0].token_type != T.SELECT and b[0].token_type != T.L_PAREN and b[0].text.upper() in ("ALL", "DISTINCT"):
            b = b[1:]
        # (SELECT ...) UNION (SELECT ...)
        if b and b[0].token_type == T.L_PAREN:
            try:
                if match_paren(b, 0) == len(b) - 1:
                    b = b[1:-1]
            except IndexError:
                pass
        cleaned.append(b)
    return cleaned


def clause_spans(sm: SourceMap, toks):
    """Spans för klausuler på djup 0 i en enskild SELECT-gren."""
    markers, depth = [], 0
    for i, t in enumerate(toks):
        tt = t.token_type
        if tt == T.L_PAREN:
            depth += 1
        elif tt == T.R_PAREN:
            depth -= 1
        elif depth == 0 and tt in _CLAUSES:
            kind = _CLAUSES[tt]
            start = i
            if kind == "join":
                while start - 1 >= 0 and toks[start - 1].token_type in _JOIN_MODIFIERS:
                    start -= 1
                if markers and markers[-1][1] >= start:  # t.ex. CROSS APPLY: redan en join
                    continue
            markers.append((kind, start, i))
    result = {"joins": [], "projections": []}
    for n, (kind, start, _) in enumerate(markers):
        end = (markers[n + 1][1] - 1) if n + 1 < len(markers) else len(toks) - 1
        if end < start:
            continue
        span = tok_span(sm, toks, start, end)
        if kind == "join":
            result["joins"].append(span)
        elif kind not in result:
            result[kind] = span
            if kind == "select":
                result["projections"] = _projection_spans(sm, toks, start + 1, end)
    return result


def _projection_spans(sm, toks, a, b):
    # hoppa över DISTINCT / TOP n [PERCENT] [WITH TIES]
    if a <= b and toks[a].token_type == T.DISTINCT:
        a += 1
    if a <= b and toks[a].token_type == getattr(T, "TOP", None):
        a += 1
        if a <= b and toks[a].token_type == T.L_PAREN:
            try:
                a = match_paren(toks, a) + 1
            except IndexError:
                return []
        else:
            a += 1
        if a <= b and toks[a].text.upper() == "PERCENT":
            a += 1
    spans, depth, seg_start = [], 0, a
    for i in range(a, b + 1):
        tt = toks[i].token_type
        if tt == T.L_PAREN:
            depth += 1
        elif tt == T.R_PAREN:
            depth -= 1
        elif depth == 0 and tt == T.COMMA:
            if i > seg_start:
                spans.append(tok_span(sm, toks, seg_start, i - 1))
            seg_start = i + 1
    if b >= seg_start:
        spans.append(tok_span(sm, toks, seg_start, b))
    return spans
