/// <reference lib="webworker" />
// Kör Pyodide + sqlglot + analyzer-paketet utanför UI-tråden.
// Allt hämtas lokalt (inget CDN, inga nätverksanrop utöver appens egna filer).
import { loadPyodide, type PyodideAPI } from "pyodide";

import type { WorkerRequest, WorkerResponse } from "./protocol";

// Enda källan till analyslogiken: samma .py-filer som pytest kör.
const pySources = import.meta.glob("../../../analyzer/cte_vizwiz/*.py", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

let ready: Promise<PyodideAPI> | null = null;

async function boot(baseUrl: string): Promise<PyodideAPI> {
  post({ type: "status", state: "loading", message: "Laddar Python-runtime…" });
  const py = await loadPyodide({ indexURL: `${baseUrl}pyodide/` });

  post({ type: "status", state: "loading", message: "Laddar SQLGlot…" });
  const res = await fetch(`${baseUrl}wheels/sqlglot.whl`);
  if (!res.ok) throw new Error(`Kunde inte läsa sqlglot-hjulet (${res.status}). Kör "npm run prepare-runtime".`);
  py.unpackArchive(await res.arrayBuffer(), "wheel");

  post({ type: "status", state: "loading", message: "Laddar dbt-stöd (Jinja)…" });
  await py.loadPackage("jinja2"); // lokalt ur public/pyodide, inget CDN

  py.FS.mkdirTree("/app/cte_vizwiz");
  for (const [path, source] of Object.entries(pySources)) {
    py.FS.writeFile(`/app/cte_vizwiz/${path.split("/").pop()}`, source);
  }
  py.runPython(`
import sys, json
sys.path.insert(0, "/app")
from cte_vizwiz import analyze as _analyze

def run(sql, dialect, options_json):
    return json.dumps(_analyze(sql, dialect, json.loads(options_json)))
`);
  post({ type: "status", state: "ready", message: "Klar" });
  return py;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    ready = boot(msg.baseUrl);
    ready.catch((e) => post({ type: "status", state: "failed", message: String(e?.message ?? e) }));
    return;
  }
  try {
    const py = await ready;
    if (!py) throw new Error("Runtime är inte initierad");
    const run = py.globals.get("run") as (sql: string, dialect: string, options: string) => string;
    post({ type: "result", id: msg.id, json: run(msg.sql, msg.dialect, JSON.stringify(msg.options)) });
  } catch (e) {
    post({ type: "error", id: msg.id, message: String((e as Error)?.message ?? e) });
  }
};
