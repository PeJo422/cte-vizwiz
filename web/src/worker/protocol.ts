/** Inställningar för analysen (dbt-läget). Speglar `options` i analyzer/cte_vizwiz/__init__.py. */
export interface AnalyzeOptions {
  /** Rendera dbt-Jinja när `{{ }}`/`{% %}` finns (standard sant). */
  dbt?: boolean;
  /** Värden för var(). */
  vars?: Record<string, unknown>;
  /** Text med `{% macro %}`-definitioner som modellen får använda. */
  macros?: string;
  /** Värde för is_incremental() (standard falskt = full körning). */
  is_incremental?: boolean;
}

export type WorkerRequest =
  | { type: "init"; baseUrl: string }
  | { type: "analyze"; id: number; sql: string; dialect: string; options: AnalyzeOptions };

export type WorkerResponse =
  | { type: "status"; state: "loading" | "ready" | "failed"; message: string }
  | { type: "result"; id: number; json: string }
  | { type: "error"; id: number; message: string };
