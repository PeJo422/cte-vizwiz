"""dbt-läge: renderar dbt-Jinja till ren SQL och håller reda på vad som hände.

Principer:
  * Riktig Jinja (sandlåda) med dbt-lik kontext. Jinja tas aldrig bort med regex.
  * Allt som inte kan lösas (okända makron, variabler utan värde) blir en synlig platshållare
    och en varning – aldrig en tyst gissning.
  * Analysen körs på den renderade SQL:en. En källkarta (markörer i mallen) översätter alla
    positioner tillbaka till originalfilen, så att klick-till-kod pekar på dbt-koden.
  * Ingen databas, ingen dbt-installation, ingen I/O: allt är ren text-till-text.
"""

from __future__ import annotations

import re
import types
from bisect import bisect_right
from dataclasses import dataclass, field

from .spans import SourceMap

M_OPEN, M_CLOSE = "", ""  # privata Unicode-tecken som markerar mallpositioner
_MARK = re.compile(M_OPEN + r"(\d+)" + M_CLOSE)
_JINJA = re.compile(r"\{\{|\{%|\{#")
PLACEHOLDER = re.compile(r"__unresolved_(\d+)__")
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")

# dbt-adapterns "type" för target.type, där den skiljer sig från sqlglot-dialekten
ADAPTER_TYPE = {"tsql": "sqlserver", "spark": "spark", "databricks": "databricks"}
_QUOTE = {"tsql": ("[", "]"), "mysql": ("`", "`"), "bigquery": ("`", "`"), "databricks": ("`", "`"), "spark": ("`", "`")}


def looks_like_jinja(sql: str) -> bool:
    return bool(_JINJA.search(sql))


class RenderError(Exception):
    def __init__(self, message: str, line: int | None = None):
        super().__init__(message)
        self.line = line


# ---------------------------------------------------------------- källkarta


@dataclass
class Segment:
    r0: int  # start i renderad text
    o0: int  # intervall i originalet
    o1: int
    linear: bool  # True = ren text (1:1), False = uttryck (hela intervallet)


class Mapper:
    """Översätter intervall i renderad SQL till intervall i originalfilen."""

    def __init__(self, segments: list[Segment]):
        self.segments = segments
        self._starts = [s.r0 for s in segments]

    def _find(self, pos: int) -> Segment:
        return self.segments[max(bisect_right(self._starts, pos) - 1, 0)]

    def map(self, start: int, end: int) -> tuple[int, int]:
        s = self._find(start)
        e = self._find(max(end - 1, start))
        a = s.o0 + min(start - s.r0, s.o1 - s.o0) if s.linear else s.o0
        b = e.o0 + min(end - e.r0, e.o1 - e.o0) if e.linear else e.o1
        return a, max(a, b)


_CAPTURE_START = {"macro", "call", "filter"}
_CAPTURE_END = {"endmacro", "endcall", "endfilter", "endset"}


def _instrument(env, source: str):
    """Sätt in markörer i mallen utan att ändra dess betydelse.

    Text  → `{{__d(k)}}` före texten.   Uttryck → `{{ __e(k, (uttryck)) }}`.
    Bara insättningar i originaltexten, så radnummer och whitespace-kontroll (`{%-`) bevaras.

    Inuti konstruktioner som *fångar* text (`{% set x %}…{% endset %}`, `{% macro %}`, `{% call %}`,
    `{% filter %}`) instrumenteras inget: markörer skulle annars hamna i värdet och t.ex. få
    `{% if x == 'a' %}` att bli falskt. Det kostar inget, eftersom allt ett `{{ }}`-uttryck ger
    ändå mappas till uttrycket som helhet.
    """
    inserts: list[tuple[int, str]] = []  # (position, text) – stigande position
    table: list[tuple[int, int, bool]] = []  # per markör: (o0, o1, linear)
    pos = 0
    in_raw = False
    capture = 0  # djup av fångande block
    block_names: list[str] | None = None  # samlas mellan block_begin och block_end
    block_assign = False
    expr_start = None
    for _, ttype, value in env.lex(source):
        if not value:
            continue
        idx = source.find(value, pos)
        if idx < 0:
            raise ValueError("tokenpositionen hittades inte")
        pos = idx + len(value)
        if ttype == "raw_begin":
            in_raw = True
        elif ttype == "raw_end":
            in_raw = False
        elif ttype == "block_begin":
            block_names, block_assign = [], False
        elif block_names is not None and ttype == "name":
            block_names.append(value)
        elif block_names is not None and ttype == "operator" and value == "=":
            block_assign = True
        elif ttype == "block_end" and block_names is not None:
            head = block_names[0] if block_names else ""
            if head in _CAPTURE_START or (head == "set" and not block_assign):
                capture += 1
            elif head in _CAPTURE_END:
                capture = max(capture - 1, 0)
            block_names = None
        elif ttype == "data" and not in_raw and capture == 0:
            table.append((idx, idx + len(value), True))
            inserts.append((idx, "{{__d(%d)}}" % (len(table) - 1)))
        elif ttype == "variable_begin" and capture == 0:
            expr_start = idx
            table.append((idx, -1, False))  # slutet fylls i vid variable_end
            inserts.append((pos, " __e(%d, (" % (len(table) - 1)))
        elif ttype == "variable_end" and expr_start is not None:
            k = len(table) - 1
            table[k] = (expr_start, pos, False)
            inserts.append((idx, ")) "))
            expr_start = None
    out, last = [], 0
    for at, text in inserts:
        out.append(source[last:at])
        out.append(text)
        last = at
    out.append(source[last:])
    return "".join(out), table


# ---------------------------------------------------------------- tillstånd och platshållare


def _jsonable(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    return str(v)


def _fmt_arg(a) -> str:
    text = a._text() if hasattr(a, "_text") else repr(a)
    return text if len(text) <= 48 else text[:45] + "…"


def _fmt_args(args, kwargs) -> str:
    return ", ".join([_fmt_arg(a) for a in args] + [f"{k}={_fmt_arg(v)}" for k, v in kwargs.items()])


class State:
    def __init__(self, dialect: str, options: dict):
        self.dialect = dialect
        self.user_vars: dict = dict(options.get("vars") or {})
        self.is_incremental = bool(options.get("is_incremental", False))
        self.table: list[tuple[int, int, bool]] = []
        self.current: int | None = None  # senaste uttrycksmarkör (var vi är i originalfilen)
        self.config: dict = {}
        self.refs: dict[str, dict] = {}
        self.sources: dict[str, dict] = {}
        self.vars: dict[str, dict] = {}
        self.unresolved: dict[str, dict] = {}
        self.warnings: list[dict] = []
        self.used_incremental = False

    def span(self):
        if self.current is None or self.current >= len(self.table):
            return None
        o0, o1, _ = self.table[self.current]
        return (o0, o1) if o1 >= 0 else None

    def warn(self, code: str, message: str, level: str = "warning"):
        key = (code, message)
        if any((w["code"], w["message"]) == key for w in self.warnings):
            return
        self.warnings.append({"code": code, "message": message, "level": level, "range": self.span()})

    def placeholder(self, text: str, kind: str) -> str:
        u = self.unresolved.get(text)
        if u is None:
            u = {"text": text, "placeholder": f"__unresolved_{len(self.unresolved) + 1}__", "kind": kind, "range": self.span()}
            self.unresolved[text] = u
            if kind == "var":
                self.warn("unresolved_var", f"Variabeln {text} saknar värde och standardvärde. Ersatt av platshållare.")
            else:
                self.warn("unresolved_macro", f"{{{{ {text} }}}} kan inte lösas utan projektets makron. Ersatt av platshållare.")
        return u["placeholder"]


_HIDDEN_ATTRS = ("unsafe_callable", "alters_data", "jinja_pass_arg", "contextfunction", "evalcontextfunction", "environmentfunction")


def _make_undefined(state: State):
    """Undefined-klass som tål attribut/anrop/indexering och ger en synlig platshållare vid utskrift."""
    from jinja2 import Undefined
    from jinja2.exceptions import UndefinedError
    from jinja2.utils import missing

    class Unresolved(Undefined):
        def __init__(self, hint=None, obj=missing, name=None, exc=UndefinedError, *, path=None, call=None, kind=None):
            super().__init__(hint=hint, obj=obj, name=name, exc=exc)
            self._path = list(path) if path is not None else ([name] if name else [])
            self._call = call
            self._kind = kind

        def _text(self) -> str:
            base = ".".join(self._path) or "?"
            return f"{base}({self._call})" if self._call is not None else base

        def __getattr__(self, name):
            # Jinjas interna kontroller (unsafe_callable, jinja_pass_arg …) får inte hitta på attribut
            if name.startswith("__") or name.startswith("_undefined") or name in _HIDDEN_ATTRS:
                raise AttributeError(name)
            return Unresolved(path=self._path + [name])

        def __getitem__(self, key):
            return Unresolved(path=self._path + [str(key)])

        def __call__(self, *args, **kwargs):
            return Unresolved(path=self._path, call=_fmt_args(args, kwargs))

        def __str__(self):
            kind = self._kind or ("macro" if self._call is not None else "name")
            return state.placeholder(self._text(), kind)

        def __iter__(self):
            state.warn("unresolved_loop", f"Loop över okänt värde {self._text()} hoppades över. SQL kan saknas.")
            return iter(())

        def __bool__(self):
            state.warn("unresolved_condition", f"Villkoret beror på okänt värde {self._text()} och räknades som falskt.")
            return False

        def __len__(self):
            return 0

        def __eq__(self, other):
            return isinstance(other, Unresolved) and other._text() == self._text()

        def __hash__(self):
            return hash(self._text())

    return Unresolved


def _quote(name: str, dialect: str) -> str:
    if _IDENT.match(name):
        return name
    left, right = _QUOTE.get(dialect, ('"', '"'))
    return f"{left}{name}{right}"


class _Config:
    def __init__(self, state: State):
        self._s = state

    def __call__(self, *args, **kwargs):
        for a in args:
            if isinstance(a, dict):
                self._s.config.update(a)
        self._s.config.update(kwargs)
        return ""

    def get(self, key, default=None):
        return self._s.config.get(key, default)

    def require(self, key):
        if key not in self._s.config:
            raise RenderError(f"config.require('{key}') saknas")
        return self._s.config[key]


class _This:
    """`{{ this }}` – modellens egen relation. Namnet är okänt här, så det är en tydlig platshållare."""

    name = identifier = "this_model"
    schema = "schema"
    database = "database"

    def __init__(self, state: State):
        self._s = state

    def __str__(self):
        self._s.refs.setdefault("this_model", {"kind": "this", "name": "this_model", "package": None, "version": None,
                                               "relation": "this_model", "range": self._s.span()})
        return "this_model"


class _Exceptions:
    def raise_compiler_error(self, message="", *a, **k):
        raise RenderError(f"dbt: {message}")

    warn = lambda self, *a, **k: ""  # noqa: E731


def _build_env(state: State, macros: str):
    from jinja2.sandbox import SandboxedEnvironment

    Unresolved = _make_undefined(state)
    env = SandboxedEnvironment(
        undefined=Unresolved,
        extensions=["jinja2.ext.do", "jinja2.ext.loopcontrols"],
        keep_trailing_newline=True,
    )

    def ref(*args, **kwargs):
        if not args or len(args) > 2 or not all(isinstance(a, str) for a in args):
            return Unresolved(path=["ref"], call=_fmt_args(args, kwargs))
        name, package = args[-1], (args[0] if len(args) == 2 else None)
        version = kwargs.get("v", kwargs.get("version"))
        relation = name if version is None else f"{name}_v{version}"
        state.refs.setdefault(relation.lower(), {"kind": "ref", "name": name, "package": package,
                                                 "version": version, "relation": relation, "range": state.span()})
        return _quote(relation, state.dialect)

    def source(*args, **kwargs):
        if len(args) != 2 or not all(isinstance(a, str) for a in args):
            return Unresolved(path=["source"], call=_fmt_args(args, kwargs))
        src, table = args
        relation = f"{src}.{table}"
        state.sources.setdefault(relation.lower(), {"kind": "source", "source": src, "table": table,
                                                    "relation": relation, "range": state.span()})
        return f"{_quote(src, state.dialect)}.{_quote(table, state.dialect)}"

    def _lookup(kind: str, label: str, values: dict, name, default, has_default: bool):
        if name in values:
            state.vars[f"{kind}:{name}"] = {"name": name, "kind": kind, "value": _jsonable(values[name]), "resolved": True, "from": "options"}
            return values[name]
        if has_default:
            state.vars[f"{kind}:{name}"] = {"name": name, "kind": kind, "value": _jsonable(default), "resolved": True, "from": "default"}
            return default
        state.vars[f"{kind}:{name}"] = {"name": name, "kind": kind, "value": None, "resolved": False, "from": None}
        return Unresolved(path=[f"{label}({name!r})"], kind="var")

    def var(name, *default):
        return _lookup("var", "var", state.user_vars, name, default[0] if default else None, bool(default))

    def env_var(name, *default):
        return _lookup("env_var", "env_var", {}, name, default[0] if default else None, bool(default))

    def is_incremental():
        state.used_incremental = True
        return state.is_incremental

    env.globals.update(
        ref=ref, source=source, var=var, env_var=env_var, is_incremental=is_incremental,
        config=_Config(state), this=_This(state), exceptions=_Exceptions(),
        target=types.SimpleNamespace(name="dev", schema="dbt", database="db", threads=1,
                                     type=ADAPTER_TYPE.get(state.dialect, state.dialect)),
        execute=False, log=lambda *a, **k: "", zip=zip,
        __d=lambda k: _mark(state, k, False), __e=lambda k, v: _mark(state, k, True, v),
    )

    if macros and macros.strip():
        module = env.from_string(macros).make_module({})
        for name in dir(module):
            if not name.startswith("_") and callable(getattr(module, name)):
                env.globals[name] = getattr(module, name)
    return env


def _mark(state: State, k: int, is_expr: bool, value=None):
    if not is_expr:
        return f"{M_OPEN}{k}{M_CLOSE}"
    state.current = k
    # Allt ett uttryck producerar hör till uttrycket som helhet. Markörer från makron som
    # definieras i filen tas bort, annars skulle positionerna peka in i makrodefinitionen.
    return f"{M_OPEN}{k}{M_CLOSE}{_MARK.sub('', str(value))}"


# ---------------------------------------------------------------- rendering


@dataclass
class Rendered:
    sql: str = ""
    mapper: Mapper | None = None
    state: State | None = None
    error: dict | None = None
    sm: SourceMap | None = None
    extra: dict = field(default_factory=dict)


def _line_span(sm: SourceMap, line: int | None):
    if not line:
        return None
    line = max(1, min(line, len(sm.starts)))
    start = sm.starts[line - 1]
    end = sm.starts[line] - 1 if line < len(sm.starts) else start + 1
    return sm.span(start, max(end, start + 1))


def _template_line(exc: BaseException) -> int | None:
    tb, line = exc.__traceback__, None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == "<template>":
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


def render(sql: str, dialect: str, options: dict, sm: SourceMap) -> Rendered:
    try:
        import jinja2  # noqa: F401
    except ImportError:
        return Rendered(error={"message": "jinja2 saknas i körmiljön, så dbt-läget kan inte starta.", "span": None})

    from jinja2 import TemplateError, TemplateSyntaxError

    state = State(dialect, options)
    out = Rendered(state=state, sm=sm)
    try:
        env = _build_env(state, options.get("macros") or "")
        env.parse(sql)  # syntaxfel rapporteras mot originalet
    except TemplateSyntaxError as e:
        out.error = {"message": f"Jinja-syntaxfel: {e.message}", "span": _line_span(sm, e.lineno)}
        return out
    except Exception as e:  # fel i inklistrade makron
        out.error = {"message": f"Makron kunde inte läsas: {e}", "span": None}
        return out

    try:
        marked, table = _instrument(env, sql)
    except Exception:
        marked, table = sql, None
    state.table = table or []

    try:
        rendered = env.from_string(marked).render()
    except RenderError as e:
        out.error = {"message": str(e), "span": _line_span(sm, e.line or _template_line(e))}
        return out
    except TemplateError as e:
        out.error = {"message": f"dbt-rendering misslyckades: {e}", "span": _line_span(sm, getattr(e, "lineno", None) or _template_line(e))}
        return out
    except Exception as e:  # t.ex. TypeError när okända värden används i uttryck
        out.error = {"message": f"dbt-rendering misslyckades ({type(e).__name__}): {e}", "span": _line_span(sm, _template_line(e))}
        return out

    # ta bort markörerna och bygg källkartan
    pieces, segments, cursor, last = [], [], 0, 0
    for m in _MARK.finditer(rendered):
        text = rendered[last:m.start()]
        pieces.append(text)
        cursor += len(text)
        k = int(m.group(1))
        if table and k < len(table):
            o0, o1, linear = table[k]
            segments.append(Segment(cursor, o0, o1, linear))
        last = m.end()
    pieces.append(rendered[last:])
    out.sql = "".join(pieces)
    if table is not None and segments:
        out.mapper = Mapper(segments)
    else:
        state.warn("spans_unavailable", "Källpositioner kunde inte bestämmas för dbt-filen", level="info")
    if state.used_incremental:
        state.warn(
            "incremental_assumed",
            "is_incremental() räknades som "
            + ("sant (inkrementell körning)" if state.is_incremental else "falskt (full körning)")
            + ". Ändra under dbt-inställningar.",
            level="info",
        )
    return out


# ---------------------------------------------------------------- efterbearbetning av IR


def _walk(obj, fn):
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            obj[k] = fn(v) if isinstance(v, str) else v
            _walk(obj[k], fn)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                obj[i] = fn(v)
            else:
                _walk(v, fn)


def _map_spans(obj, mapper: Mapper, sm: SourceMap, seen: set[int] | None = None):
    """Räkna om alla spans till originalet. `seen` gör det idempotent även om samma dict delas."""
    seen = set() if seen is None else seen
    if isinstance(obj, dict):
        if id(obj) in seen:
            return
        seen.add(id(obj))
        if {"start", "end", "line", "col", "end_line", "end_col"} <= obj.keys():
            a, b = mapper.map(obj["start"], obj["end"])
            obj.update(sm.span(a, b))
            return
        for v in obj.values():
            _map_spans(v, mapper, sm, seen)
    elif isinstance(obj, list):
        for v in obj:
            _map_spans(v, mapper, sm, seen)


def finalize(result: dict, rendered: Rendered, sm_orig: SourceMap, options: dict) -> dict:
    """Skrubba platshållare, flytta positioner till originalfilen, märk dbt-noder och bifoga dbt-info."""
    state = rendered.state
    by_placeholder = {u["placeholder"]: u for u in state.unresolved.values()}

    def display(ph: str) -> str:
        u = by_placeholder.get(ph)
        return "{{ " + u["text"] + " }}" if u else ph

    # 1) platshållare är inga riktiga kolumner: markera dem och rensa falska källkolumner
    for st in result["statements"]:
        for node in st["nodes"]:
            if node["kind"] == "source":
                node["columns"] = [c for c in node["columns"] if not PLACEHOLDER.fullmatch(c["name"])]
            for c in node["columns"]:
                c["sources"] = [s for s in c["sources"] if not PLACEHOLDER.fullmatch(s["column"])]
                if PLACEHOLDER.fullmatch(c["name"]) or PLACEHOLDER.fullmatch(c["expression"]):
                    c.update(change="unresolved", sources=[], via_star=False)

    # 2) positioner → originalfilen (före dbt-varningarna, som redan ligger i originalets koordinater)
    if rendered.mapper is not None:
        _map_spans(result, rendered.mapper, sm_orig)
    else:
        _strip_spans(result)

    # 3) platshållare → läsbar text
    _walk(result, lambda s: PLACEHOLDER.sub(lambda m: display(m.group(0)), s) if "__unresolved_" in s else s)

    # 4) dbt-info på källnoderna
    for st in result["statements"]:
        for node in st["nodes"]:
            node["dbt"] = None
            if node["kind"] != "source":
                continue
            key = node["id"].lower()
            info = state.refs.get(key) or state.sources.get(key)
            if info:
                node["dbt"] = {k: v for k, v in info.items() if k != "range"}
            elif node["id"].startswith("{{ "):
                node["dbt"] = {"kind": "unresolved", "text": node["id"][3:-3]}

    # 5) varningar och sammanfattning
    def rng(r):
        return sm_orig.span(*r) if r else None

    for w in state.warnings:
        result["warnings"].append({"code": w["code"], "message": w["message"], "level": w["level"],
                                   "node": None, "span": rng(w["range"]), "statement": None})
    result["dbt"] = {
        "config": _jsonable(state.config),
        "refs": [{k: v for k, v in r.items() if k != "range"} | {"span": rng(r["range"])} for r in state.refs.values()],
        "sources": [{k: v for k, v in r.items() if k != "range"} | {"span": rng(r["range"])} for r in state.sources.values()],
        "vars": list(state.vars.values()),
        "unresolved": [{"text": u["text"], "kind": u["kind"], "span": rng(u["range"])} for u in state.unresolved.values()],
        "is_incremental": state.is_incremental,
        "rendered_sql": PLACEHOLDER.sub(lambda m: display(m.group(0)), rendered.sql),
    }
    return result


def _strip_spans(obj):
    """Utan källkarta är positioner i den renderade texten meningslösa för originalet."""
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if isinstance(v, dict) and {"start", "end", "line"} <= v.keys():
                obj[k] = None
            else:
                _strip_spans(v)
    elif isinstance(obj, list):
        for v in obj:
            _strip_spans(v)
