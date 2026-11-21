// Newline-delimited JSON-RPC 2.0 over a child's stdio: what `codex app-server` and every ACP agent
// speak. Requests in both directions, notifications, and a clean failure of everything pending
// when the process ends.
import type { ChildProcess } from "node:child_process";

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class ProcessEnded extends Error {}

type Handler = (params: any) => unknown | Promise<unknown>;

export class JsonRpc {
  #seq = 0;
  #pending = new Map<
    number | string,
    { resolve(v: any): void; reject(e: Error): void }
  >();
  #requests = new Map<string, Handler>();
  #notes = new Set<(method: string, params: any) => void>();
  #buf = "";
  #ended: Error | null = null;
  /** The last lines the process wrote to stderr, for diagnosing a failure. */
  stderr = "";
  readonly exited: Promise<void>;

  constructor(
    readonly child: ChildProcess,
    private opts: { jsonrpcField?: boolean } = {},
  ) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => this.#read(d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-8000);
    });
    child.stdin!.on("error", () => {});
    this.exited = new Promise((resolve) => {
      const end = () => {
        this.#end(new ProcessEnded("the agent process ended"));
        resolve();
      };
      child.once("exit", end);
      child.once("error", end);
    });
  }

  get ended() {
    return this.#ended !== null;
  }

  /** Handles one method the agent calls on us; returning a value answers it. */
  handle(method: string, handler: Handler) {
    this.#requests.set(method, handler);
  }

  /** Every notification (and every request without a handler is answered "method not found"). */
  onNotification(fn: (method: string, params: any) => void) {
    this.#notes.add(fn);
    return () => this.#notes.delete(fn);
  }

  request<T = any>(
    method: string,
    params?: unknown,
    timeoutMs = 0,
  ): Promise<T> {
    if (this.#ended) return Promise.reject(this.#ended);
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0)
        timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.#ended)
      this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  #write(msg: Record<string, unknown>) {
    const line = JSON.stringify(
      this.opts.jsonrpcField === false ? msg : { jsonrpc: "2.0", ...msg },
    );
    this.child.stdin!.write(line + "\n");
  }

  #read(chunk: string) {
    this.#buf += chunk;
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // a vendor's stray log line on stdout
      }
      if (m.method === undefined && m.id !== undefined) {
        const p = this.#pending.get(m.id);
        if (!p) continue;
        this.#pending.delete(m.id);
        if (m.error)
          p.reject(
            new RpcError(
              m.error.code ?? -1,
              m.error.message ?? "error",
              m.error.data,
            ),
          );
        else p.resolve(m.result);
      } else if (m.method !== undefined && m.id !== undefined)
        void this.#answer(m);
      else if (m.method !== undefined)
        for (const fn of this.#notes) fn(m.method, m.params);
    }
  }

  async #answer(m: any) {
    const handler = this.#requests.get(m.method);
    if (!handler) {
      this.#write({
        id: m.id,
        error: { code: -32601, message: `${m.method} is not supported` },
      });
      return;
    }
    try {
      const result = await handler(m.params);
      if (!this.#ended) this.#write({ id: m.id, result: result ?? null });
    } catch (e: any) {
      if (!this.#ended)
        this.#write({
          id: m.id,
          error: {
            code: e instanceof RpcError ? e.code : -32603,
            message: String(e?.message ?? e),
          },
        });
    }
  }

  #end(e: Error) {
    if (this.#ended) return;
    this.#ended = e;
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
  }

  /** Ends the process (the sandbox's own kill: TERM, then KILL). */
  close() {
    if (!this.#ended) this.child.kill("SIGTERM");
    return this.exited;
  }
}
