/**
 * Shared child-process helpers for every place strut shells out (the agent
 * step's repo tools + bash, the chat builder's bash). One implementation so
 * timeout semantics, output capping, and — critically — env scrubbing are
 * identical everywhere.
 *
 * **Env scrubbing.** Children get a MINIMAL environment (`minimalEnv`), not
 * `process.env`: the strut server's env holds exactly the credentials the
 * secrets boundary exists to keep away from models (ANTHROPIC_API_KEY,
 * STRUT_SECRET_KEY, provider keys, …) — a naive spawn would hand them to any
 * model-authored `env`/`printenv` one-liner. Steps get credentials via
 * `ctx.services.secrets`, never ambient env, so scrubbing costs adapters
 * nothing.
 */

import { spawn } from "node:child_process";

/** Allowlisted env vars a shell needs to behave normally (run tools from
 *  PATH, resolve ~, write temp files, keep git/locale sane). Everything
 *  else — API keys above all — is withheld. */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
] as const;

/** The scrubbed child env: allowlisted vars from `process.env` only. */
export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/** Spawn a child, capture stdout with a timeout + output cap. Exit 1 with no
 *  stderr → "No matches found" (grep/rg/find idiom). */
export function capture(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const cap = (s: string) =>
      s.length > maxBytes ? s.slice(0, maxBytes) + "\n\n[... output truncated ...]" : s;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > maxBytes) {
        child.kill("SIGKILL");
        finish(() => resolve(cap(stdout)));
      }
    });
    // stderr is capped the same way stdout is: a failing build can emit
    // megabytes, and an uncapped string here both risks V8's max string
    // length and dumps the whole thing into a tool result the model reads.
    child.stderr?.on("data", (d) => {
      if (stderr.length <= maxBytes) stderr += d.toString();
    });
    child.on("close", (code) =>
      finish(() => {
        if (code === 0) resolve(cap(stdout));
        else if (code === 1 && !stderr) resolve(cap(stdout) || "No matches found");
        else reject(new Error(`Command failed (${code}): ${cap(stderr || stdout || "Unknown error")}`));
      }),
    );
    child.on("error", (err) => finish(() => reject(err)));
  });
}

/** Run a program with explicit args (NO shell) — safe for untrusted args like a
 *  search query (no quoting/escaping/injection). Scrubbed env. */
export const runCmd = (cmd: string, args: string[], cwd: string, timeoutMs = 10000, maxBytes = 10000) =>
  capture(
    spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: minimalEnv() }),
    timeoutMs,
    maxBytes,
  );

/** Run an arbitrary shell command string (the `bash` tools need a full shell).
 *  Scrubbed env — model-authored commands never see the server's API keys.
 *
 *  `extraEnv` is the ONE sanctioned widening of the scrubbed env: the agent
 *  step's `secretsEnv` config resolves named secrets via ctx.services.secrets
 *  and injects the VALUES here — into the subprocess env only, never into a
 *  prompt or log (the model writes `$NAME`; the shell expands it at exec
 *  time, and the agent step masks the values out of every tool output before
 *  the model or the event log sees them). Callers other than that path should
 *  not pass it. */
export const runShell = (
  command: string,
  cwd: string,
  timeoutMs = 15000,
  maxBytes = 10000,
  extraEnv?: Record<string, string>,
) =>
  capture(
    spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: extraEnv && Object.keys(extraEnv).length ? { ...minimalEnv(), ...extraEnv } : minimalEnv(),
    }),
    timeoutMs,
    maxBytes,
  );

// ── subprocess: the primitive under ctx.services.shell + the exec step ──────

/** Replace every occurrence of each secret value in `text` with a marker.
 *  Plain string splitting (no regex) — values are opaque tokens. Shared by
 *  the agent step (tool outputs) and the exec step (stdout/stderr). */
export function maskSecretValues(text: string, values: string[]): string {
  let out = text;
  for (const v of values) out = out.split(v).join("[MASKED_SECRET]");
  return out;
}

export interface ProcessRequest {
  /** Program to run, resolved from PATH. No shell: `args` reach the program
   *  verbatim (safe for templated values). For a pipeline run `bash -c`. */
  cmd: string;
  args?: string[];
  cwd: string;
  /** Piped to the child's stdin, then closed. Absent → stdin is closed. */
  stdin?: string;
  /** Widens the scrubbed env (`minimalEnv`). Never `process.env`. */
  env?: Record<string, string>;
  /** SIGKILL the process group after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Per-stream cap: past it the head and tail are kept and the middle is
   *  dropped — the child keeps running. Default 500k chars. */
  maxOutputChars?: number;
  /** Abort → SIGTERM the process group, SIGKILL 2s later. */
  signal?: AbortSignal;
}

export interface ProcessResult {
  /** Exit code, or null when the child died from a signal (timeout/abort). */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Either stream exceeded `maxOutputChars`. */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Bounded capture of one stream: the first half of the budget verbatim and
 *  the last half as a rolling tail, so both a JSON result (head) and the
 *  error that ended a build (tail) survive truncation. */
class OutputSink {
  private head = "";
  private tail = "";
  private total = 0;
  private readonly headMax: number;
  private readonly tailMax: number;
  constructor(max: number) {
    this.headMax = Math.floor(max / 2);
    this.tailMax = max - this.headMax;
  }
  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.headMax) {
      const take = this.headMax - this.head.length;
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
    }
    if (chunk) {
      this.tail += chunk;
      if (this.tail.length > this.tailMax) this.tail = this.tail.slice(-this.tailMax);
    }
  }
  get truncated(): boolean {
    return this.total > this.headMax + this.tailMax;
  }
  text(): string {
    if (!this.truncated) return this.head + this.tail;
    const dropped = this.total - this.head.length - this.tail.length;
    return `${this.head}\n[... ${dropped} chars truncated ...]\n${this.tail}`;
  }
}

/** Run a program and capture its outcome — the primitive under
 *  `ctx.services.shell` (capabilities.ts) and the `exec` step. Unlike
 *  `runCmd`/`runShell` it never throws on a non-zero exit (the result carries
 *  `code`), doesn't kill on big output, and takes stdin + an abort signal.
 *
 *  The child gets its own process group (`detached`, non-Windows) so a kill
 *  reaches the whole tree — a `bash -c "a | b"`, or a script that spawned
 *  ffmpeg — not just the immediate child. (The group also outlives a crash of
 *  the server, as the agent's `bash` children already do.) Spawn failure,
 *  e.g. a program that isn't on PATH, rejects. */
export function runProcess(req: ProcessRequest): Promise<ProcessResult> {
  const { cmd, args = [], cwd, stdin, env, timeoutMs = 600_000, maxOutputChars = 500_000, signal } = req;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: env && Object.keys(env).length ? { ...minimalEnv(), ...env } : minimalEnv(),
      detached,
    });
    const out = new OutputSink(maxOutputChars);
    const err = new OutputSink(maxOutputChars);
    let timedOut = false;
    let settled = false;

    const kill = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (detached) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => out.push(d));
    child.stderr?.on("data", (d: string) => err.push(d));
    if (stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE when the child exits before reading
      child.stdin.end(stdin);
    }
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(() => reject(e.code === "ENOENT" ? new Error(`command not found: ${cmd}`) : e)),
    );
    child.on("close", (code, sig) =>
      finish(() =>
        resolve({
          code,
          signal: sig,
          stdout: out.text(),
          stderr: err.text(),
          truncated: out.truncated || err.truncated,
          timedOut,
          durationMs: Date.now() - started,
        }),
      ),
    );
  });
}
