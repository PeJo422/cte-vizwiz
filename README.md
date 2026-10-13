# CTE VizWiz

Visualiserar hur en SQL-fråga (eller dbt-modell) med CTE:er byggs upp: varje CTE är en virtuell tabell, och du ser steg för steg
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

## Vyer och interaktion

- **Flöde:** CTE-korten från vänster till höger. **Dra korten** där du vill ha dem (kanterna följer med), "Återställ layout" lägger tillbaka dem och "Anpassa vy" zoomar in. Håll över en kolumn för att se dess ursprung, **klicka** för att låsa den (Enter/Blanksteg fungerar också).
- **Följ lineage:** när en kolumn är låst visar detaljpanelen ett spår med klickbara namn: *Ursprung* (uppströms) och *Används i* (nedströms). Klick på ett namn hoppar dit, markerar noden/steget, låser den kolumnen och centrerar vyn.
- **Steg för steg:** en tabell som växer åt höger (nya kolumner), krymper (genomstrukna borttagna kolumner) och får färgband efter källa. Kolumnrubrikerna är klickbara och visar samma lineage-spår. Piltangenter bläddrar. Detta är också det tangentbordsvänliga sättet att använda appen.
- **Justerbara fönster:** dra i listen mellan kod och visualisering (bredd) och mellan diagram och detaljer (höjd). Piltangenter fungerar när listen har fokus, dubbelklick återställer. Detaljpanelen kan fällas ihop och kodpanelen döljas ("Kod"). Storlekarna sparas i webbläsaren.
- **dbt:** modeller med Jinja renderas automatiskt (se nedan). Källtabeller märks *dbt ref* / *dbt source*, och Jinja-taggar får egen bakgrund i editorn. Knappen **dbt** öppnar en panel med det som hittades (config, ref, source, var, okända uttryck), inställningar och den kompilerade SQL:en.
- **Editorn i sidled:** hjul/styrplatta och de alltid synliga scrollistorna, **mittenknapp + dra** panorerar fritt, och "Radbrytning" bryter långa rader. Klick i koden väljer kortet, klick på kortet markerar koden.

## dbt-stöd

Ingen dbt-installation, inget projekt och ingen databas behövs. Modellfilen renderas med **riktig Jinja** (`jinja2` i Pyodide, sandlåda) och en dbt-lik kontext, och den renderade SQL:en analyseras. Jinja tas aldrig bort med regex.

| Stöds | Anmärkning |
|---|---|
| `config()`, `ref()` (även paket och `v=`), `source()`, `this`, `target`, `var()`, `env_var()` | `ref`/`source` blir märkta källnoder; `config` visas i dbt-panelen |
| `{% if %}`, `{% for %}`, `{% set %}`, `{% macro %}` i filen, `{%- -%}` | Egna makron kan också klistras in under *dbt-inställningar* |
| `is_incremental()` | Ett uttryckligt antagande (standard: full körning), omkopplare i panelen |
| Klick-till-kod | Alla positioner översätts tillbaka till din dbt-fil via en källkarta, så klick på en CTE markerar `{{ ref() }}`-koden |

**Aldrig tyst.** Det som inte kan lösas utan projektet (t.ex. `dbt_utils.star(...)`, `var('x')` utan värde, loop/villkor över okända värden) blir en synlig platshållare, en `?`-kolumn och status *Delvis analys*. Fel i Jinja eller i SQL:en efter rendering rapporteras mot rätt rad i originalfilen.

Källkartan bygger på markörer som sätts in i mallen. `analyzer/tests/test_dbt.py` har ett differentialtest som kräver att instrumenterad rendering ger exakt samma SQL som vanlig Jinja för alla fixturer, så att kartan aldrig ändrar vad mallen betyder.

## Arkitektur

```
SQL ─► [Web Worker: Pyodide + SQLGlot + analyzer/] ─► IR (JSON) ─► React (CodeMirror + React Flow)
```

| Mapp | Innehåll |
|---|---|
| `analyzer/` | Ren Python. `analyze(sql, dialect, options)` returnerar IR. Testas med pytest, och exakt samma filer körs i webbläsaren. `dbt.py` renderar dbt-Jinja och bygger källkartan. |
| `web/src/ir.ts` | TypeScript-kontraktet för IR:n. `ir.contract.test.ts` kontrollerar det mot `analyzer/tests/golden/*.json`. |
| `web/src/lib/` | Rena hjälpfunktioner (lineage, layout, steg, förklaringstexter). Frontend tolkar aldrig SQL. |
| `scripts/fetch-runtime.mjs` | Hämtar Pyodide, jinja2/markupsafe (sha256-verifierade mot Pyodides låsfil) och sqlglot-hjulet lokalt, så att inget laddas från CDN vid körning. |

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

- dbt: bara enskilda modeller. Ingen `manifest.json`, inget projekt och inga paketmakron (`dbt_utils` m.fl.), så modell-till-modell-lineage via `ref()` visas inte och okända makron blir platshållare. `run_query`, `adapter` och liknande som kräver ett datalager löses inte. Egna makron går att klistra in.
- T-SQL är mest testad. Andra dialekter väljs i listan men har bara ytlig testtäckning.
- Inline-underfrågor i FROM plattas ut. Underfrågor i uttryck, rekursiva CTE:er, PIVOT och CROSS APPLY-kolumner expanderas inte.
- Inget användarschema ännu, så `SELECT *` från en källtabell förblir okänd.

## Senare

dbt-projekt (ladda mapp/`manifest.json` för modell-till-modell-lineage och projektets makron), användarschema, VS Code-extension (webview som återanvänder samma bundle bakom `Host`-interfacet i `web/src/host.ts`).
