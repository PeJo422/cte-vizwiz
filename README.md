# CTE VizWiz

Visualiserar hur en SQL-fråga med CTE:er byggs upp: varje CTE är en virtuell tabell, och du ser steg för steg
vilka kolumner som ärvs, läggs till, räknas om eller försvinner, och vad som händer med raderna
(filter, join, group by, union, window).

**Ingen databasanslutning och ingen data.** Verktyget gör ren statisk analys av SQL-texten. Allt körs lokalt i
webbläsaren (Python via Pyodide + SQLGlot), utan nätverksanrop. Produktionsbygget har en CSP som bara tillåter den egna origin.

## Kom igång

Krav: Node (testat med 24), Python 3 (bara för att hämta sqlglot-hjulet första gången).

```bash
cd web
npm install
npm run prepare-runtime   # kopierar Pyodide + hämtar sqlglot till web/public (engång; körs även av predev/prebuild)
npm run dev               # http://localhost:5173
```

Första sidladdningen startar Pyodide (~10 MB, lokalt) och tar några sekunder.

## Vyer

- **Flöde:** CTE-korten från vänster till höger. Håll över en kolumn för att följa dess ursprung genom alla steg, klicka för att låsa. Klick på ett kort markerar koden, klick i koden väljer kortet.
- **Steg för steg:** en tabell som växer åt höger (nya kolumner), krymper (genomstrukna borttagna kolumner) och får färgband efter vilken källa kolumnerna kommer från. Piltangenter bläddrar. Detta är också det tangentbordsvänliga sättet att använda appen.

## Arkitektur

```
SQL ─► [Web Worker: Pyodide + SQLGlot + analyzer/] ─► IR (JSON) ─► React (CodeMirror + React Flow)
```

| Mapp | Innehåll |
|---|---|
| `analyzer/` | Ren Python. `analyze(sql, dialect)` returnerar IR. Testas med pytest, och exakt samma filer körs i webbläsaren. |
| `web/src/ir.ts` | TypeScript-kontraktet för IR:n. `ir.contract.test.ts` kontrollerar det mot `analyzer/tests/golden/*.json`. |
| `web/src/lib/` | Rena hjälpfunktioner (lineage, layout, steg, förklaringstexter). Frontend tolkar aldrig SQL. |
| `scripts/fetch-runtime.mjs` | Hämtar Pyodide och sqlglot-hjulet lokalt (ingen CDN). |

IR:n skiljer tabell-lineage (`edges`, `inputs`) från kolumn-lineage (`columns[].sources`) och har status
`ok | partial | error`. Allt som inte kan analyseras säkert (Jinja, rekursiva CTE:er, underfrågor i uttryck,
tvetydiga kolumner) blir en varning och status `partial`, aldrig en tyst gissning. `SELECT *` mot en
tabell utan känt schema visas som `∗ (okända kolumner)`.

## Tester

```bash
cd analyzer && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && .venv/Scripts/python -m pytest
cd web && npm test          # kontrakt + lineage/steg-logik
cd web && npm run e2e       # riktig webbläsare (Edge/Chrome): bygger, kör användarflöden och bevisar offline-drift
```

`UPDATE_GOLDEN=1 pytest` skriver om golden-filerna efter en avsiktlig ändring av IR:n (granska diffen).

## Begränsningar (MVP)

- Ren SQL. dbt/Jinja upptäcks och markeras men tolkas inte (nästa steg: `ref()/source()` och dbt-kompilering).
- T-SQL är mest testad. Andra dialekter väljs i listan men har bara ytlig testtäckning.
- Inline-underfrågor i FROM plattas ut. Underfrågor i uttryck, rekursiva CTE:er, PIVOT och CROSS APPLY-kolumner expanderas inte.
- Inget användarschema ännu, så `SELECT *` från en källtabell förblir okänd.

## Senare

dbt-läge, användarschema, VS Code-extension (webview som återanvänder samma bundle bakom `Host`-interfacet i `web/src/host.ts`).
