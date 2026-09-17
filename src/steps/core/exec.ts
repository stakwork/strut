import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve as pathResolve, sep } from "node:path";
import { defineStep } from "../../core.js";
import {
  shellCapability,
  type ShellCapability,
  type ShellResult,
  type StrutCapabilities,
} from "../../capabilities.js";
import { maskSecretValues } from "../../shell.js";

const EXAMPLE = `- id: download
  type: exec
  config:
    cmd: yt-dlp
    args: ["-f", "mp4", "-o", "video.mp4", "{{ input.url }}"]

- id: timeline
  type: exec
  depends: [download]
  config:
    cmd: uv
    args: ["run"]
    parseJson: true
    script: |
      # /// script
      # dependencies = ["opencv-python-headless", "rapidocr-onnxruntime"]
      # ///
      import json
      # ... open video.mp4 from the working dir, OCR a frame per second ...
      print(json.dumps({"segments": [{"start": 12.0, "text": "..."}]}))

- id: clips
  type: foreach
  depends: [timeline]
  config:
    items: "{{ timeline.json.segments }}"
    body:
      id: cut
      type: exec
      config:
        cmd: ffmpeg
        args: ["-y", "-ss", "{{ $current.start }}", "-t", "30", "-i", "video.mp4", "clip-{{ $index }}.mp4"]`;

/** File extension for an inline `script`, by interpreter — so uv/python get a
 *  .py, node gets ESM, bash gets .sh. Unknown interpreters get none; set
 *  `scriptFile` to control the name. */
const SCRIPT_EXT: Record<string, string> = {
  uv: "py",
  uvx: "py",
  python: "py",
  pypy: "py",
  node: "mjs",
  bun: "ts",
  deno: "ts",
  tsx: "ts",
  bash: "sh",
  sh: "sh",
  zsh: "sh",
  dash: "sh",
  ruby: "rb",
  perl: "pl",
  php: "php",
};

function defaultScriptFile(cmd: string, path: string | undefined): string {
  const base = basename(cmd).replace(/\.exe$/i, "");
  const ext = SCRIPT_EXT[base] ?? SCRIPT_EXT[base.replace(/[\d.]+$/, "")] ?? ""; // python3.12 → python
  const stem = (path ?? "script").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `exec-${stem}${ext ? "." + ext : ""}`;
}

/** Templated args/env values may resolve to numbers or booleans. */
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export default defineStep({
  type: "exec",
  description:
    `Run a program as a subprocess with no LLM in the loop — the deterministic way to call a CLI or a script (yt-dlp, ffmpeg, Python via uv, node) from a workflow. No shell: cmd runs directly with args passed verbatim, so templated values are never re-parsed; for a pipeline use cmd: bash with args: ["-c", "..."], or an inline script. ` +
    `Python with dependencies: cmd: uv, args: [run] and a script with a PEP 723 header (# /// script / # dependencies = [...] / # ///) — uv installs the packages on the fly (cached after the first run, no image change). ` +
    `Files: the working dir defaults to the run's artifact dir, so files flow between exec/agent steps by relative path and are served at GET /artifacts/:runId/<path>; put big results in files, not stdout. ` +
    `A non-zero exit or timeout throws (so retry/onError apply) unless allowFailure. The child env is scrubbed — no server keys reach it; pass credentials via secretsEnv.\n\n` +
    EXAMPLE,
  input: z.object({
    cmd: z.string().describe("program to run, resolved from PATH; runs directly, no shell"),
    args: z.array(Scalar).default([]).describe("arguments, passed verbatim (numbers/booleans stringified)"),
    script: z
      .string()
      .optional()
      .describe(
        "inline source, written to a file in the working dir whose path is appended to args (uv run → Python with PEP 723 inline deps; bash → shell script)",
      ),
    scriptFile: z
      .string()
      .optional()
      .describe("file name for `script`, relative to the working dir (default exec-<step path>.<ext by interpreter>)"),
    cwd: z
      .string()
      .optional()
      .describe("working dir: absolute, or relative to the run's artifact dir (the default)"),
    stdin: z.any().optional().describe("piped to stdin: a string as-is, anything else as JSON"),
    env: z
      .record(z.string(), Scalar)
      .default({})
      .describe("extra env vars (plain values — the rest of the env is scrubbed). Credentials go in secretsEnv"),
    secretsEnv: z
      .array(z.string())
      .default([])
      .describe(
        "secret NAMES injected as env vars: values come from the secret store and are masked out of stdout/stderr, never logged",
      ),
    timeoutMs: z.number().int().positive().default(600_000).describe("kill the process after this long (default 10 min)"),
    maxOutputChars: z
      .number()
      .int()
      .positive()
      .default(500_000)
      .describe("per-stream cap (default 500k chars); past it the head and tail are kept. Write big results to files instead"),
    parseJson: z.boolean().default(false).describe("parse stdout as JSON into output.json (throws if it isn't JSON)"),
    allowFailure: z.boolean().default(false).describe("a non-zero exit returns the normal output (check code) instead of throwing"),
  }),
  output: z.object({
    code: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    json: z.any().optional(),
    cwd: z.string(),
    durationMs: z.number(),
    truncated: z.boolean(),
  }),
  async run(cfg, ctx) {
    const services = (ctx.services ?? {}) as Partial<StrutCapabilities>;
    // The deployment's shell capability (recordable, env-scrubbed); a local
    // one when none was injected (bare `runWorkflow(..., { services: {} })`).
    const shell: ShellCapability = services.shell ?? shellCapability();

    // Working dir: the run's artifact dir unless told otherwise, so files
    // flow between exec/agent steps by relative path and are served by
    // GET /artifacts/:runId/<path>. A relative cwd stays inside that dir.
    let cwd: string;
    if (cfg.cwd && isAbsolute(cfg.cwd)) {
      cwd = cfg.cwd;
    } else {
      if (!services.artifacts) {
        throw new Error("exec: no artifacts capability in ctx.services — set an absolute `cwd`");
      }
      const base = await services.artifacts.dir(ctx.runId);
      cwd = cfg.cwd ? pathResolve(base, cfg.cwd) : base;
      if (cwd !== base && !cwd.startsWith(base + sep)) {
        throw new Error(`exec: relative cwd escapes the run's artifact dir: ${cfg.cwd}`);
      }
    }
    await mkdir(cwd, { recursive: true });

    const args = cfg.args.map(String);
    if (cfg.script !== undefined) {
      const file = cfg.scriptFile ?? defaultScriptFile(cfg.cmd, ctx.path);
      if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
        throw new Error(`exec: scriptFile must be a relative path inside the working dir: ${file}`);
      }
      const abs = join(cwd, file);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, cfg.script);
      args.push(abs);
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env)) env[k] = String(v);
    // secretsEnv: values are resolved here, in code, and go two places only —
    // the child env and the mask list. Never the config, events, or output.
    const secretValues: string[] = [];
    if (cfg.secretsEnv.length) {
      const secrets = services.secrets;
      if (!secrets) throw new Error("exec: secretsEnv requires the secrets capability (ctx.services.secrets)");
      for (const name of cfg.secretsEnv) {
        const v = await secrets.get(name);
        if (v === undefined) {
          throw new Error(`exec: secret "${name}" is not in the secret store — add it under Secrets or drop it from secretsEnv`);
        }
        env[name] = v;
        // Very short values would mask common substrings all over the output.
        if (v.length >= 6) secretValues.push(v);
      }
    }

    const stdin =
      cfg.stdin === undefined ? undefined : typeof cfg.stdin === "string" ? cfg.stdin : JSON.stringify(cfg.stdin);

    // Cancel: run control is cooperative (checkpoints at step boundaries) and
    // a subprocess is one unit, so watch the state while it runs, kill the
    // child when the run starts cancelling, then let checkpoint() raise the
    // canonical CancelledError. Pause is left alone (in-flight leaves finish).
    const ac = new AbortController();
    const control = ctx.control;
    const watch = control
      ? setInterval(() => {
          if (control.state === "cancelling") ac.abort();
        }, 200)
      : undefined;
    let res: ShellResult;
    try {
      res = await shell({
        cmd: cfg.cmd,
        args,
        cwd,
        stdin,
        env,
        timeoutMs: cfg.timeoutMs,
        maxOutputChars: cfg.maxOutputChars,
        signal: ac.signal,
      });
    } finally {
      if (watch) clearInterval(watch);
    }
    if (ac.signal.aborted && control) await control.checkpoint();

    const mask = (s: string) => maskSecretValues(s, secretValues);
    const stdout = mask(res.stdout);
    const stderr = mask(res.stderr);
    const label = mask([cfg.cmd, ...cfg.args.map(String)].join(" ")).slice(0, 200);
    const tail = (s: string) => (s.length > 4000 ? "…" + s.slice(-4000) : s);
    if (res.timedOut) {
      throw new Error(`exec: "${label}" timed out after ${cfg.timeoutMs}ms\n${tail(stderr)}`.trimEnd());
    }
    if (res.code !== 0 && !cfg.allowFailure) {
      const how = res.code === null ? `was killed by ${res.signal}` : `exited with code ${res.code}`;
      throw new Error(`exec: "${label}" ${how}\n${tail(stderr || stdout)}`.trimEnd());
    }
    const parse = cfg.parseJson && res.code === 0;
    let json: unknown;
    if (parse) {
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        throw new Error(
          `exec: parseJson — stdout of "${label}" is not JSON` +
            (res.truncated ? " (it was truncated: raise maxOutputChars or write the result to a file)" : "") +
            `: ${stdout.trim().slice(0, 200)}`,
        );
      }
    }
    return {
      code: res.code,
      stdout,
      stderr,
      ...(parse ? { json } : {}),
      cwd,
      durationMs: res.durationMs,
      truncated: res.truncated,
    };
  },
});
