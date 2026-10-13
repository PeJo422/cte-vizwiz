import json
from pathlib import Path

import pytest

from cte_vizwiz import analyze

FIXTURES = Path(__file__).parent / "fixtures"


def load(name):
    return (FIXTURES / f"{name}.sql").read_text(encoding="utf-8")


def nodes(r, stmt=0):
    return {n["id"]: n for n in r["statements"][stmt]["nodes"]}


def cols(n):
    return {c["name"]: c for c in n["columns"]}


def cut(sql, span):
    return sql[span["start"]:span["end"]]


# ------------------------------------------------------------- rendering


def test_plain_sql_is_untouched_and_has_no_dbt_block():
    r = analyze("WITH a AS (SELECT x FROM t) SELECT * FROM a")
    assert r["dbt"] is None
    assert all(n["dbt"] is None for n in r["statements"][0]["nodes"])


def test_config_ref_and_source_are_resolved():
    r = analyze(load("dbt_orders"))
    assert r["status"] == "ok", r["warnings"]
    d = r["dbt"]
    assert d["config"] == {"materialized": "incremental", "unique_key": "order_id", "tags": ["finance"]}
    assert [x["relation"] for x in d["refs"]] == ["stg_customers"]
    assert [x["relation"] for x in d["sources"]] == ["shop.raw_orders"]
    n = nodes(r)
    assert n["stg_customers"]["dbt"]["kind"] == "ref"
    assert n["shop.raw_orders"]["dbt"] == {"kind": "source", "source": "shop", "table": "raw_orders", "relation": "shop.raw_orders"}
    assert n["totals"]["dbt"] is None


def test_loops_macros_in_file_and_whitespace_control_render_to_valid_sql():
    r = analyze(load("dbt_orders"))
    sql = r["dbt"]["rendered_sql"]
    assert "WHERE o.status IN ('completed','shipped')" in sql
    assert "ROUND(SUM(amount) / 100.0, 2) AS total_dollars" in sql
    assert "{%" not in sql and "{{" not in sql
    assert cols(nodes(r)["totals"])["total_dollars"]["change"] == "aggregate"


def test_var_uses_default_and_option_overrides_it():
    r = analyze(load("dbt_orders"))
    assert "'2024-01-01'" in r["dbt"]["rendered_sql"]
    assert r["dbt"]["vars"] == [{"name": "start_date", "kind": "var", "value": "2024-01-01", "resolved": True, "from": "default"}]
    r = analyze(load("dbt_orders"), options={"vars": {"start_date": "2025-06-01"}})
    assert "'2025-06-01'" in r["dbt"]["rendered_sql"]
    assert r["dbt"]["vars"][0]["from"] == "options"


def test_is_incremental_is_an_explicit_assumption():
    full = analyze(load("dbt_orders"))
    inc = analyze(load("dbt_orders"), options={"is_incremental": True})
    assert "this_model" not in full["dbt"]["rendered_sql"]
    assert "FROM this_model" in inc["dbt"]["rendered_sql"]
    assert any(w["code"] == "incremental_assumed" and w["level"] == "info" for w in full["warnings"])
    assert full["status"] == "ok"
    assert any(r["kind"] == "this" for r in inc["dbt"]["refs"])


def test_versioned_ref_package_ref_and_odd_names():
    r = analyze("SELECT * FROM {{ ref('pkg', 'dim_user', v=2) }} u JOIN {{ ref('my-model') }} m ON 1=1", "tsql")
    sql = r["dbt"]["rendered_sql"]
    assert "dim_user_v2" in sql and "[my-model]" in sql
    refs = {x["relation"]: x for x in r["dbt"]["refs"]}
    assert refs["dim_user_v2"]["package"] == "pkg" and refs["dim_user_v2"]["version"] == 2
    assert nodes(r)["dim_user_v2"]["dbt"]["kind"] == "ref"


def test_project_macros_can_be_supplied():
    macros = "{% macro active(col) %}{{ col }} = 1{% endmacro %}"
    r = analyze("SELECT a FROM t WHERE {{ active('flag') }}", options={"macros": macros})
    assert r["status"] == "ok", r["warnings"]
    assert "WHERE flag = 1" in r["dbt"]["rendered_sql"]


# ------------------------------------------------------------- aldrig tyst


def test_unknown_macros_and_vars_become_visible_placeholders_and_partial():
    r = analyze(load("dbt_unresolved"))
    assert r["status"] == "partial"
    codes = {w["code"] for w in r["warnings"]}
    assert {"unresolved_macro", "unresolved_var"} <= codes
    texts = [u["text"] for u in r["dbt"]["unresolved"]]
    assert "dbt_utils.star('stg_orders')" in texts and "var('cutoff')" in texts
    base = cols(nodes(r)["base"])
    star = base["{{ dbt_utils.star('stg_orders') }}"]
    assert star["change"] == "unresolved" and star["sources"] == []
    assert base["order_key"]["change"] == "unresolved"
    assert base["amount"]["change"] == "passthrough"


def test_placeholders_do_not_leak_into_source_columns_or_ids():
    r = analyze(load("dbt_unresolved"))
    blob = json.dumps(r)
    assert "__unresolved_" not in blob
    assert [c["name"] for c in nodes(r)["stg_orders"]["columns"]] == ["amount"]


def test_unresolved_spans_point_at_the_jinja_expression():
    sql = load("dbt_unresolved")
    r = analyze(sql)
    for u in r["dbt"]["unresolved"]:
        assert cut(sql, u["span"]).startswith("{{") and cut(sql, u["span"]).endswith("}}")
    w = next(w for w in r["warnings"] if w["code"] == "unresolved_var")
    assert cut(sql, w["span"]) == """{{ var("cutoff") }}"""


def test_unresolved_loop_and_condition_are_reported():
    r = analyze("SELECT {% for c in mystery_cols %}{{ c }},{% endfor %} 1 AS x FROM t {% if flag_from_nowhere %}WHERE 1=0{% endif %}")
    codes = {w["code"] for w in r["warnings"]}
    assert {"unresolved_loop", "unresolved_condition"} <= codes
    assert r["status"] == "partial"


# ------------------------------------------------------------- källkarta


def test_spans_point_into_the_dbt_file_not_the_rendered_sql():
    sql = load("dbt_orders")
    n = nodes(analyze(sql))
    for name in ("source_orders", "customers", "filtered", "totals"):
        ns = n[name]["name_span"]
        assert cut(sql, ns) == name
    body = cut(sql, n["source_orders"]["body_span"])
    assert "{{ source('shop', 'raw_orders') }}" in body
    where = next(o for o in n["filtered"]["operations"] if o["type"] == "filter")
    text = cut(sql, where["span"])
    assert text.startswith("WHERE o.status IN (") and "{%- for s in statuses %}" in text
    c = cols(n["totals"])["total_dollars"]
    assert cut(sql, c["span"]) == "{{ to_dollars('SUM(amount)') }} AS total_dollars"
    out = n["<output>"]
    assert cut(sql, out["span"]).startswith("SELECT * FROM totals")


def test_raw_blocks_and_comments_do_not_break_positions():
    sql = "{# kommentar #}\n{% raw %}-- {{ inte jinja }}{% endraw %}\nWITH a AS (SELECT x FROM t)\nSELECT * FROM a"
    r = analyze(sql)
    assert r["status"] == "ok", (r["errors"], r["warnings"])
    ns = nodes(r)["a"]["name_span"]
    assert cut(sql, ns) == "a" and ns["line"] == 3


def test_every_span_in_the_ir_is_inside_the_original_file():
    sql = load("dbt_orders")
    r = analyze(sql, options={"is_incremental": True})

    def spans(o):
        if isinstance(o, dict):
            if {"start", "end", "line"} <= o.keys():
                yield o
            else:
                for v in o.values():
                    yield from spans(v)
        elif isinstance(o, list):
            for v in o:
                yield from spans(v)

    found = list(spans(r))
    assert len(found) > 20
    for s in found:
        assert 0 <= s["start"] <= s["end"] <= len(sql)
        assert 1 <= s["line"] <= s["end_line"] <= sql.count("\n") + 1


# ------------------------------------------------------------- fel och säkerhet


def test_jinja_syntax_error_points_at_the_line():
    r = analyze("WITH a AS (\n  SELECT {{ ref('x') }\n)\nSELECT * FROM a")
    assert r["status"] == "error"
    assert "Jinja" in r["errors"][0]["message"]
    assert r["errors"][0]["span"]["line"] in (2, 3)


def test_sql_error_after_rendering_is_mapped_to_the_original():
    sql = "{{ config(materialized='view') }}\nSELECT FROM WHERE {{ ref('x') }}"
    r = analyze(sql)
    assert r["status"] == "error"
    assert r["errors"][0]["span"]["line"] == 2


def test_compiler_error_from_a_model_is_reported():
    r = analyze("{% if true %}{{ exceptions.raise_compiler_error('modellen är avstängd') }}{% endif %}SELECT 1")
    assert r["status"] == "error"
    assert "modellen är avstängd" in r["errors"][0]["message"]


def test_template_cannot_escape_the_sandbox():
    r = analyze("SELECT {{ ''.__class__.__mro__[1].__subclasses__() }} FROM t")
    assert r["status"] in ("error", "partial")
    assert "subprocess" not in json.dumps(r)


def test_dbt_mode_can_be_switched_off():
    r = analyze("WITH a AS (SELECT x FROM {{ ref('t') }}) SELECT * FROM a", options={"dbt": False})
    assert r["status"] == "error"
    assert any(w["code"] == "jinja" for w in r["warnings"]) or "Jinja" in r["errors"][0]["message"]


@pytest.mark.parametrize("dialect", ["tsql", "snowflake", "postgres"])
def test_adapter_type_follows_the_dialect(dialect):
    r = analyze("SELECT '{{ target.type }}' AS t", dialect)
    expected = {"tsql": "sqlserver"}.get(dialect, dialect)
    assert f"'{expected}'" in r["dbt"]["rendered_sql"]


# ------------------------------------------------------------- källkartan får aldrig ändra mallens betydelse

TEMPLATES = [
    "{% set cols %}a, b{% endset %}SELECT {% if cols == 'a, b' %}1{% else %}0{% endif %} AS ok FROM t",
    "{% macro m() %}x{% endmacro %}{% set v = m() %}SELECT {% if v == 'x' %}1{% else %}0{% endif %} AS ok FROM t",
    "{% macro wrap() %}({{ caller() }}){% endmacro %}SELECT 1 AS ok FROM t WHERE {% call wrap() %}a = 1{% endcall %}",
    "SELECT {% filter upper %}abc{% endfilter %} AS x FROM t",
    "SELECT   {%- if true -%}   1   {%- endif -%}   AS x FROM t",
    "SELECT {{- ' a ' -}} AS x, {{ ' b ' | trim }} AS y FROM t",
    "SELECT {% for i in range(3) %}{{ i }}{{ ',' if not loop.last }}{% endfor %} AS x",
    "{% raw %}-- {{ ref('x') }}{% endraw %}\nSELECT 1 AS x",
    "SELECT {# kommentar #} 1 AS x\n{%- set n = namespace(v=0) %}{% do n.__setattr__('v', 1) if false %}",
]


@pytest.mark.parametrize("sql", TEMPLATES + [load("dbt_orders"), load("jinja"), load("dbt_unresolved")])
def test_instrumentation_never_changes_what_the_template_renders(sql):
    from cte_vizwiz import dbt

    state = dbt.State("tsql", {})
    env = dbt._build_env(state, "")
    marked, table = dbt._instrument(env, sql)
    rendered = env.from_string(marked).render()
    stripped = dbt._MARK.sub("", rendered)
    state2 = dbt.State("tsql", {})
    plain = dbt._build_env(state2, "").from_string(sql).render()
    # okända makron får olika platshållarnummer mellan körningarna – jämför utan dem
    norm = lambda t: dbt.PLACEHOLDER.sub("__P__", t)  # noqa: E731
    assert norm(stripped) == norm(plain)
