// Förbereder webbappens offline-runtime:
//   * kopierar Pyodide (WASM + stdlib) från node_modules till web/public/pyodide
//   * hämtar jinja2 + markupsafe (för dbt-läget) ur Pyodide-distributionen, sha256-verifierade
//     mot pyodide-lock.json, till web/public/pyodide (där loadPackage hittar dem)
//   * hämtar sqlglot-hjulet (ren Python) till web/public/wheels
// Körs i utvecklingsmiljön, aldrig i användarens webbläsare. Efter detta behöver
// appen inget nätverk alls.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const pyodideDir = join(web, "node_modules", "pyodide");
const pyodideOut = join(web, "public", "pyodide");
const wheelsOut = join(web, "public", "wheels");
const sqlglotWheel = join(wheelsOut, "sqlglot.whl");
const ifMissing = process.argv.includes("--if-missing");

const PYODIDE_FILES = ["pyodide.asm.wasm", "pyodide.asm.mjs", "python_stdlib.zip", "pyodide-lock.json"];
// Pyodide-paket som dbt-läget behöver (deras beroenden följer med automatiskt).
const PYODIDE_PACKAGES = ["jinja2"];

const requirements = readFileSync(join(root, "analyzer", "requirements.txt"), "utf8");
const pinOf = (name) => requirements.split(/\r?\n/).find((l) => l.startsWith(`${name}==`));
const sqlglotPin = pinOf("sqlglot");
if (!sqlglotPin) throw new Error("analyzer/requirements.txt måste pinna sqlglot==x.y.z");

const lock = JSON.parse(readFileSync(join(pyodideDir, "pyodide-lock.json"), "utf8"));
const pyodideVersion = JSON.parse(readFileSync(join(pyodideDir, "package.json"), "utf8")).version;
const wanted = new Map();
const collect = (name) => {
  const pkg = lock.packages[name];
  if (!pkg) throw new Error(`Paketet ${name} finns inte i pyodide-lock.json`);
  if (wanted.has(name)) return;
  wanted.set(name, pkg);
  (pkg.depends ?? []).forEach(collect);
};
PYODIDE_PACKAGES.forEach(collect);

// Testmiljön (pytest) ska köra samma jinja2-version som webbläsaren.
const jinjaPin = `jinja2==${wanted.get("jinja2").version}`;
if (pinOf("jinja2") !== jinjaPin) {
  throw new Error(`analyzer/requirements.txt måste pinna ${jinjaPin} (samma som Pyodide), men har: ${pinOf("jinja2") ?? "ingen pin"}`);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const packageOk = (pkg) => existsSync(join(pyodideOut, pkg.file_name)) && sha256(join(pyodideOut, pkg.file_name)) === pkg.sha256;

const haveAll =
  existsSync(sqlglotWheel) &&
  PYODIDE_FILES.every((f) => existsSync(join(pyodideOut, f))) &&
  [...wanted.values()].every(packageOk);
if (ifMissing && haveAll) process.exit(0);

mkdirSync(pyodideOut, { recursive: true });
for (const f of PYODIDE_FILES) copyFileSync(join(pyodideDir, f), join(pyodideOut, f));
console.log(`pyodide: kopierade ${PYODIDE_FILES.length} filer`);

for (const [name, pkg] of wanted) {
  if (packageOk(pkg)) continue;
  const url = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/${pkg.file_name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kunde inte hämta ${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== pkg.sha256) {
    throw new Error(`sha256 stämmer inte för ${pkg.file_name}`);
  }
  writeFileSync(join(pyodideOut, pkg.file_name), bytes);
  console.log(`pyodide-paket: ${name} → ${pkg.file_name}`);
}

rmSync(wheelsOut, { recursive: true, force: true });
mkdirSync(wheelsOut, { recursive: true });
const py = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
execFileSync(
  py,
  ["-m", "pip", "download", sqlglotPin, "--no-deps", "--only-binary", ":all:", "--dest", wheelsOut, "--quiet"],
  { stdio: "inherit" },
);
const wheels = readdirSync(wheelsOut).filter((f) => f.endsWith(".whl"));
if (wheels.length !== 1 || !wheels[0].endsWith("-py3-none-any.whl")) {
  throw new Error(`Förväntade ett rent Python-hjul (py3-none-any), fick: ${wheels.join(", ")}`);
}
// stabilt filnamn så att workern slipper veta versionen
copyFileSync(join(wheelsOut, wheels[0]), sqlglotWheel);
rmSync(join(wheelsOut, wheels[0]));
console.log(`sqlglot: ${wheels[0]} -> wheels/sqlglot.whl`);
