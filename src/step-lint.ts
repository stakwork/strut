/**
 * The static check on a custom step's SOURCE: does it reach past
 * `ctx.services`? A step gets the shell, files, the network and credentials
 * through the services bag — recordable by a cassette, secrets masked, the
 * child env scrubbed. The three ways around it that this finds:
 *
 * - importing `node:child_process`, `node:fs`, `node:net` / `http` / `https`
 *   (and the other modules below) — the shell, the disk and the wire direct;
 * - reading `process.env` — the server's own env, where the deployment's
 *   keys arrive (empty once the default server scrubbed it, src/env.ts, but
 *   a step must not depend on that);
 * - calling the global `fetch` — the wire without the cassette or masking.
 *
 * Where it runs: the builder's `create_step` / `edit_step` (and their meta/*
 * twins) REFUSE on a finding — the model-authored door, where the prompt
 * already says all three; `POST /steps` WARNS and answers with the findings,
 * since a host's own step is the host's call. The module loader warns at
 * import time for whatever is on disk (strut-resolve-hook.ts). Comments are
 * ignored. A determined author can get around a regex; the hook, and a
 * refusal there later, is the enforcement.
 */

/** Module → what to use instead. Matched with or without the `node:` prefix. */
export const RISKY_MODULES: Record<string, string> = {
  child_process: "ctx.services.shell — a subprocess with a scrubbed env, recordable",
  fs: "ctx.services.artifacts — the run's own files",
  "fs/promises": "ctx.services.artifacts — the run's own files",
  net: "ctx.services.http",
  http: "ctx.services.http",
  https: "ctx.services.http",
  http2: "ctx.services.http",
  dns: "ctx.services.http",
  tls: "ctx.services.http",
  dgram: "ctx.services.http",
  worker_threads: "nothing: a step is one function over ctx.services",
  vm: "nothing: a step is one function over ctx.services",
  cluster: "nothing: a step is one function over ctx.services",
};

export interface StepLintFinding {
  /** 1-based line in the source as given. */
  line: number;
  message: string;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](?:node:)?([a-z_]+(?:\/[a-z_]+)?)["']/g;
const ENV_RE = /\bprocess\.env\b/;
const FETCH_RE = /(?<![.\w$])fetch\s*\(/;

/** Blank out comments, keeping every line where it is. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/[^\n]*/g, (m, lead: string) => lead);
}

/** Every line that reaches past `ctx.services`, in order. Empty = clean. */
export function lintStepSource(source: string): StepLintFinding[] {
  const out: StepLintFinding[] = [];
  stripComments(source)
    .split("\n")
    .forEach((text, i) => {
      const line = i + 1;
      for (const m of text.matchAll(IMPORT_RE)) {
        const mod = m[1]!;
        const use = RISKY_MODULES[mod];
        if (use) out.push({ line, message: `imports ${mod} — use ${use}` });
      }
      if (ENV_RE.test(text)) {
        out.push({ line, message: "reads process.env — credentials come from ctx.services.secrets.get(NAME); the server's env holds nothing else for a step" });
      }
      if (FETCH_RE.test(text)) {
        out.push({ line, message: "calls the global fetch — use ctx.services.http(url, opts), which a cassette records and masks" });
      }
    });
  return out;
}

/** The findings as one message, a line each. */
export function formatStepLint(findings: StepLintFinding[]): string {
  return findings.map((f) => `line ${f.line}: ${f.message}`).join("\n");
}
