import { SUPPORTED_SCHEMA_VERSION, type Ir } from "../ir";
import type { AnalyzeOptions, WorkerRequest, WorkerResponse } from "./protocol";

export type RuntimeState = { state: "loading" | "ready" | "failed"; message: string };

interface Pending {
  resolve: (ir: Ir) => void;
  reject: (e: Error) => void;
}

export class StaleError extends Error {
  constructor() {
    super("stale");
  }
}

/** Tunn brygga till analys-workern. Senaste anropet vinner; äldre avvisas med StaleError. */
class AnalyzerClient {
  runtime: RuntimeState = { state: "loading", message: "Startar…" };
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(s: RuntimeState) => void>();
  private nextId = 1;
  private latest = 0;

  constructor() {
    this.worker = new Worker(new URL("./analyzer.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.setRuntime({ state: "failed", message: e.message || "Workern kraschade" });
    this.send({ type: "init", baseUrl: new URL(import.meta.env.BASE_URL, location.href).href });
  }

  subscribe(fn: (s: RuntimeState) => void): () => void {
    this.listeners.add(fn);
    fn(this.runtime);
    return () => this.listeners.delete(fn);
  }

  analyze(sql: string, dialect: string, options: AnalyzeOptions = {}): Promise<Ir> {
    const id = this.nextId++;
    this.latest = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "analyze", id, sql, dialect, options });
    });
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.type === "status") return this.setRuntime({ state: msg.state, message: msg.message });
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "error") return p.reject(new Error(msg.message));
    if (msg.id !== this.latest) return p.reject(new StaleError());
    try {
      const ir = JSON.parse(msg.json) as Ir;
      if (ir.schema_version !== SUPPORTED_SCHEMA_VERSION) throw new Error(`Okänd IR-version ${ir.schema_version}`);
      p.resolve(ir);
    } catch (err) {
      p.reject(err as Error);
    }
  }

  private setRuntime(s: RuntimeState) {
    this.runtime = s;
    this.listeners.forEach((fn) => fn(s));
  }

  private send(msg: WorkerRequest) {
    this.worker.postMessage(msg);
  }
}

let instance: AnalyzerClient | null = null;
/** En enda worker per sida – även under React StrictMode. */
export const analyzer = () => (instance ??= new AnalyzerClient());
