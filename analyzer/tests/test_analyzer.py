import json
import os
from pathlib import Path

import pytest

from cte_vizwiz import analyze

HERE = Path(__file__).parent
FIXTURES = sorted((HERE / "fixtures").glob("*.sql"))


def load(name):
    return (HERE / "fixtures" / f"{name}.sql").read_text(encoding="utf-8")


def nodes(result, stmt=0):
    return {n["id"]: n for n in result["statements"][stmt]["nodes"]}


def cols(node):
    return {c["name"]: c for c in node["columns"]}


def src(c):
    return [(s["node"], s["column"]) for s in c["sources"]]


# ------------------------------------------------------------- golden


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_golden(path):
    result = analyze(path.read_text(encoding="utf-8"))
    golden = HERE / "golden" / f"{path.stem}.json"
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if os.environ.get("UPDATE_GOLDEN") or not golden.exists():
        golden.write_text(text, encoding="utf-8")
    assert json.loads(golden.read_text(encoding="utf-8")) == result


def test_ir_is_json_serializable():
    for path in FIXTURES:
        json.dumps(analyze(path.read_text(encoding="utf-8")))


# ------------------------------------------------------------- sales.sql


def test_sales_chain():
    r = analyze(load("sales"))
    assert r["status"] == "ok"
    st = r["statements"][0]
    assert st["order"] == ["raw_orders", "orders", "filtered_orders", "customer_totals", "<output>"]
    n = nodes(r)
    assert [i["node"] for i in n["orders"]["inputs"]] == ["raw_orders"]
    assert [i["node"] for i in n["filtered_orders"]["inputs"]] == ["orders"]
    assert [o["type"] for o in n["filtered_orders"]["operations"]] == ["select", "filter"]
    assert n["filtered_orders"]["operations"][1]["expression"] == "amount > 100"
    assert list(cols(n["filtered_orders"])) == ["order_id", "customer_id", "amount"]
    assert n["filtered_orders"]["shape"]["rows"] == "fewer"


def test_sales_column_lineage_and_shape():
    n = nodes(analyze(load("sales")))
    ct = n["customer_totals"]
    assert cols(ct)["customer_id"]["change"] == "passthrough"
    assert cols(ct)["total_amount"]["change"] == "aggregate"
    assert src(cols(ct)["total_amount"]) == [("filtered_orders", "amount")]
    assert ct["columns_added"] == ["total_amount"]
    assert sorted(ct["columns_removed"]) == ["amount", "order_id"]
    assert ct["shape"] == {"width_delta": -1, "rows": "collapsed"}
    assert [c["name"] for c in n["<output>"]["columns"]] == ["customer_id", "total_amount"]


def test_sales_spans_point_at_the_right_text():
    sql = load("sales")
    n = nodes(analyze(sql))
    for name in ("orders", "filtered_orders", "customer_totals"):
        ns = n[name]["name_span"]
        assert sql[ns["start"]:ns["end"]] == name
        body = n[name]["body_span"]
        assert sql[body["start"]:body["end"]].lstrip().upper().startswith("SELECT")
    f = n["filtered_orders"]["operations"][1]["span"]
    assert sql[f["start"]:f["end"]].strip().upper().startswith("WHERE AMOUNT > 100")
    o = n["<output>"]["span"]
    assert sql[o["start"]:o["end"]].lstrip().upper().startswith("SELECT *")
    ct = n["customer_totals"]["columns"]
    assert sql[ct[1]["span"]["start"]:ct[1]["span"]["end"]] == "SUM(amount) AS total_amount"


# ------------------------------------------------------------- joins etc.


def test_join_window_and_star():
    n = nodes(analyze(load("joins")))
    e = n["enriched"]
    assert [(i["node"], i["role"]) for i in e["inputs"]] == [("orders", "from"), ("customers", "join")]
    assert e["inputs"][1]["join_type"] == "LEFT"
    assert e["inputs"][1]["on"] == "c.customer_id = o.customer_id"
    assert src(cols(e)["customer_name"]) == [("customers", "name")]
    assert cols(e)["customer_name"]["change"] == "renamed"
    assert cols(e)["amount_incl_vat"]["change"] == "derived"
    assert cols(e)["rn"]["change"] == "window"
    assert sorted(src(cols(e)["rn"])) == [("orders", "customer_id"), ("orders", "order_date")]
    assert e["columns_added"] == ["customer_name", "country", "amount_incl_vat", "rn"]
    assert e["shape"]["rows"] == "unknown"
    out = n["<output>"]
    assert [c["name"] for c in out["columns"]] == [
        "order_id", "amount", "customer_name", "country", "amount_incl_vat", "rn", "flag",
    ]
    assert cols(out)["flag"]["change"] == "literal"
    assert [o["type"] for o in out["operations"]] == ["select", "filter", "distinct"]


def test_source_nodes_list_only_referenced_columns():
    n = nodes(analyze(load("joins")))
    assert [c["name"] for c in n["dbo.customers"]["columns"]] == ["customer_id", "name", "country"]
    assert n["dbo.customers"]["kind"] == "source"


# ------------------------------------------------------------- T-SQL


def test_tsql_leading_semicolon_brackets_top_union_and_column_list():
    sql = load("tsql_union")
    r = analyze(sql)
    assert r["status"] == "ok", r["warnings"]
    n = nodes(r)
    assert "Sales 2023" in n
    assert [o["type"] for o in n["Sales 2023"]["operations"]] == ["select", "order", "limit"]
    assert n["Sales 2023"]["operations"][2]["expression"] == "TOP 10"
    assert list(cols(n["sales_2024"])) == ["id", "amt"]  # kolumnlistan döper om
    a = n["all_sales"]
    assert [(i["node"], i["role"]) for i in a["inputs"]] == [("Sales 2023", "from"), ("sales_2024", "union")]
    assert [o["type"] for o in a["operations"]] == ["select", "union", "select"]
    assert a["operations"][1]["expression"] == "UNION ALL"
    assert a["shape"]["rows"] == "more"
    assert cols(a)["id"]["change"] == "merged"
    assert sorted(src(cols(a)["id"])) == [("Sales 2023", "Order Id"), ("sales_2024", "id")]
    ns = a["name_span"]
    assert sql[ns["start"]:ns["end"]] == "all_sales"
    out = n["<output>"]
    assert [o["type"] for o in out["operations"]] == ["select", "aggregate", "filter"]
    assert out["operations"][2]["details"]["clause"] == "HAVING"


# ------------------------------------------------------------- ofullständig analys


def test_star_from_unknown_table_is_marked_not_guessed():
    r = analyze(load("star_unknown"))
    n = nodes(r)
    assert cols(n["src"])["*"]["change"] == "star_unknown"
    assert [c["name"] for c in n["typed"]["columns"]] == ["*", "day"]
    assert any(w["code"] == "star_unknown" for w in r["warnings"])
    assert r["status"] == "ok"  # info-nivå, men synligt i kolumnerna


def test_inline_subquery_is_flattened_and_expression_subquery_is_flagged():
    r = analyze(load("subquery"))
    n = nodes(r)
    assert [i["node"] for i in n["base"]["inputs"]] == ["t"]
    assert src(cols(n["base"])["id"]) == [("t", "id")]
    assert [o["type"] for o in n["base"]["operations"] if o["details"].get("scope")] == ["select", "filter"]
    assert {w["code"] for w in r["warnings"]} >= {"inline_subquery", "subquery_in_expression"}
    assert r["status"] == "partial"


def test_jinja_with_dbt_mode_off_is_never_silently_visualized():
    r = analyze(load("jinja"), options={"dbt": False})
    assert r["status"] in ("partial", "error")
    assert "Jinja" in r["errors"][0]["message"]
    assert any(w["code"] == "jinja" for w in r["warnings"])


def test_jinja_comment_with_dbt_mode_off_is_partial():
    r = analyze("WITH a AS (SELECT x FROM t /* {# kommentar #} */) SELECT * FROM a", options={"dbt": False})
    assert r["status"] == "partial"
    assert any(w["code"] == "jinja" for w in r["warnings"])


def test_syntax_error_is_data_not_exception():
    r = analyze(load("syntax_error"))
    assert r["status"] == "error"
    assert r["statements"] == []
    assert r["errors"][0]["span"]["line"] == 1


def test_empty_and_non_query_input():
    assert analyze("")["status"] == "error"
    assert analyze("DROP TABLE x")["status"] == "error"


def test_recursive_cte_is_flagged():
    r = analyze("WITH n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT * FROM n")
    assert any(w["code"] == "recursive_cte" for w in r["warnings"])
    assert r["status"] == "partial"


def test_ambiguous_unqualified_column_warns_instead_of_guessing():
    r = analyze("SELECT id FROM a JOIN b ON a.k = b.k")
    assert any(w["code"] == "ambiguous_column" for w in r["warnings"])
    assert r["status"] == "partial"


# ------------------------------------------------------------- övrigt


def test_no_cte_and_multiple_statements():
    r = analyze(load("no_cte"))
    assert r["status"] == "ok"
    assert [n["id"] for n in r["statements"][0]["nodes"]] == ["dbo.orders", "<output>"]
    r = analyze(load("multi_statement"))
    assert len(r["statements"]) == 2
    assert "b" in nodes(r, 1) and "a" not in nodes(r, 1)


def test_other_dialect_is_a_parameter():
    r = analyze("WITH a AS (SELECT x FROM t LIMIT 5) SELECT * FROM a", dialect="mysql")
    assert r["status"] == "ok"
    assert r["dialect"] == "mysql"
    assert analyze("SELECT 1", dialect="nope")["status"] == "error"
