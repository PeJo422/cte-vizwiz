import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// Ingen-anslutning-garanti: i produktionsbygget får sidan bara prata med sin egen origin.
// (Dev-servern behöver inline-skript för hot reload och får därför ingen CSP.)
const csp: Plugin = {
  name: "cte-vizwiz-csp",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content: [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      },
      injectTo: "head-prepend",
    },
  ],
};

export default defineConfig({
  plugins: [react(), csp],
  base: "./",
  worker: { format: "es" },
  optimizeDeps: { exclude: ["pyodide"] },
  server: {
    // workern läser analyzer/*.py som råtext (?raw) – enda källan till analyslogiken
    fs: { allow: [".."] },
  },
  test: { environment: "node" },
});
