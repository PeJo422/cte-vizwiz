// Speglar IR:n som analyzer/cte_vizwiz producerar (schema_version 1).
// Kontraktet hålls i synk av src/ir.contract.test.ts mot analyzer/tests/golden/*.json.

export const SUPPORTED_SCHEMA_VERSION = 1;

export type Status = "ok" | "partial" | "error";

export interface Span {
  start: number; // tecken-offset, inklusive
  end: number; // exklusive
  line: number; // 1-baserad
  col: number;
  end_line: number;
  end_col: number;
}

export type NodeKind = "source" | "cte" | "output";

export type Change =
  | "source"
  | "passthrough"
  | "renamed"
  | "derived"
  | "aggregate"
  | "window"
  | "literal"
  | "merged"
  | "star_unknown"
  | "unresolved"; // okänt dbt-uttryck (makro) – ersatt av en platshållare

export type OperationType =
  | "select"
  | "filter"
  | "join"
  | "aggregate"
  | "distinct"
  | "union"
  | "window"
  | "order"
  | "limit";

export type RowEffect = "same" | "fewer" | "more" | "collapsed" | "unknown";

export interface ColumnRef {
  node: string;
  column: string;
}

export interface Column {
  name: string;
  expression: string;
  change: Change;
  sources: ColumnRef[];
  via_star: boolean;
  span: Span | null;
}

export interface Operation {
  type: OperationType;
  expression: string;
  span: Span | null;
  details: {
    join_type?: string;
    source?: string | null;
    on?: string | null;
    using?: string[] | null;
    group_by?: string[];
    clause?: "WHERE" | "HAVING" | "QUALIFY";
    kind?: string;
    branch?: number;
    scope?: string;
  };
}

export interface NodeInput {
  node: string;
  role: "from" | "join" | "union";
  alias: string | null;
  join_type?: string;
  on?: string | null;
}

/** dbt-härkomst för en källnod. */
export type DbtNodeInfo =
  | { kind: "ref"; name: string; package: string | null; version: string | number | null; relation: string }
  | { kind: "source"; source: string; table: string; relation: string }
  | { kind: "this"; name: string; package: null; version: null; relation: string }
  | { kind: "unresolved"; text: string };

export interface IrNode {
  id: string;
  kind: NodeKind;
  span: Span | null;
  name_span: Span | null;
  body_span: Span | null;
  inputs: NodeInput[];
  operations: Operation[];
  columns: Column[];
  columns_added: string[];
  columns_removed: string[];
  columns_modified: string[];
  shape: { width_delta: number | null; rows: RowEffect };
  dbt: DbtNodeInfo | null;
}

export interface Edge {
  from: string;
  to: string;
  role: "from" | "join" | "union";
  join_type: string | null;
}

export interface Statement {
  index: number;
  span: Span | null;
  nodes: IrNode[];
  edges: Edge[];
  output_node: string;
  order: string[];
}

export interface Warning {
  code: string;
  message: string;
  level: "warning" | "info";
  node: string | null;
  span: Span | null;
  statement?: number | null;
}

export interface AnalysisError {
  message: string;
  span: Span | null;
}

export interface DbtVar {
  name: string;
  kind: "var" | "env_var";
  value: unknown;
  resolved: boolean;
  from: "options" | "default" | null;
}

export interface DbtSummary {
  config: Record<string, unknown>;
  refs: { kind: "ref" | "this"; name: string; package: string | null; version: string | number | null; relation: string; span: Span | null }[];
  sources: { kind: "source"; source: string; table: string; relation: string; span: Span | null }[];
  vars: DbtVar[];
  unresolved: { text: string; kind: "macro" | "name" | "var"; span: Span | null }[];
  is_incremental: boolean;
  /** SQL efter rendering (platshållare som `{{ makro() }}`). */
  rendered_sql: string;
}

export interface Ir {
  schema_version: number;
  dialect: string;
  status: Status;
  warnings: Warning[];
  errors: AnalysisError[];
  statements: Statement[];
  /** Finns när dbt-Jinja renderades. */
  dbt: DbtSummary | null;
}

export const OUTPUT_ID = "<output>";
