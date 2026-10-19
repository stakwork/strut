import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * A minimal Agent Client Protocol client (agentclientprotocol.com): JSON-RPC
 * 2.0, one message per line, over a child's stdio. Only the client half the
 * `acp/prompt` step needs — initialize, session/new|load|set_mode|set_model|
 * prompt|cancel, and answering the agent's session/request_permission. It
 * advertises no fs or terminal capability, so the agent uses its own tools.
 */

export interface AcpUpdate {
  sessionUpdate: string;
  [k: string]: unknown;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface AcpHandlers {
  update: (sessionId: string, update: AcpUpdate) => void;
  permission: (req: PermissionRequest) => PermissionOutcome | Promise<PermissionOutcome>;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class AcpClient {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";
  private exited: Promise<number | null>;

  constructor(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }, private handlers: AcpHandlers) {
    this.child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.on("data", (d) => (this.stderr = (this.stderr + String(d)).slice(-8000)));
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
    this.exited = new Promise((resolve) => {
      this.child.on("error", (e) => {
        this.failAll(new Error(`acp: could not start ${cmd}: ${e.message}`));
        resolve(null);
      });
      this.child.on("exit", (code) => {
        this.failAll(new Error(`acp: ${cmd} exited (${code ?? "signal"})${this.tail()}`));
        resolve(code);
      });
    });
  }

  /** The last lines the agent wrote to stderr, for an error message. */
  tail(): string {
    const t = this.stderr.trim().split("\n").slice(-5).join("\n");
    return t ? `: ${t}` : "";
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 2000);
    await this.exited;
    clearTimeout(timer);
  }

  private send(msg: unknown): void {
    if (this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // an agent's stray log line on stdout
    }
    // A response to one of ours.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`acp: ${msg.error.message ?? "error"}${msg.error.data ? ` ${JSON.stringify(msg.error.data)}` : ""}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      this.handlers.update(msg.params?.sessionId, msg.params?.update ?? {});
      return;
    }
    // A request from the agent: answer it, or say we don't do it.
    if (msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        Promise.resolve(this.handlers.permission(msg.params))
          .then((outcome) => this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome } }))
          .catch(() => this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }));
        return;
      }
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }
}
