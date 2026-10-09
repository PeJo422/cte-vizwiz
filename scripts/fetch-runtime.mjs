// Förbereder webbappens offline-runtime:
//   * kopierar Pyodide (WASM + stdlib) från node_modules till web/public/pyodide
//   * hämtar sqlglot-hjulet (ren Python) till web/public/wheels
// Körs i utvecklingsmiljön, aldrig i användarens webbläsare. Efter detta behöver
// appen inget nätverk alls.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");
const pyodideOut = join(web, "public", "pyodide");
const wheelsOut = join(web, "public", "wheels");
const ifMissing = process.argv.includes("--if-missing");

const PYODIDE_FILES = ["pyodide.asm.wasm", "pyodide.asm.mjs", "python_stdlib.zip", "pyodide-lock.json"];

const requirements = readFileSync(join(root, "analyzer", "requirements.txt"), "utf8");
const sqlglotPin = requirements.split(/\r?\n/).find((l) => l.startsWith("sqlglot=="));
if (!sqlglotPin) throw new Error("analyzer/requirements.txt måste pinna sqlglot==x.y.z");

const haveWheel = existsSync(wheelsOut) && readdirSync(wheelsOut).some((f) => f.startsWith("sqlglot-") && f.endsWith(".whl"));
const havePyodide = PYODIDE_FILES.every((f) => existsSync(join(pyodideOut, f)));
if (ifMissing && haveWheel && havePyodide) process.exit(0);

mkdirSync(pyodideOut, { recursive: true });
for (const f of PYODIDE_FILES) {
  copyFileSync(join(web, "node_modules", "pyodide", f), join(pyodideOut, f));
}
console.log(`pyodide: kopierade ${PYODIDE_FILES.length} filer`);

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
copyFileSync(join(wheelsOut, wheels[0]), join(wheelsOut, "sqlglot.whl"));
rmSync(join(wheelsOut, wheels[0]));
console.log(`sqlglot: ${wheels[0]} -> wheels/sqlglot.whl`);
