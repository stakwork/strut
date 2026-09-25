import { z } from "zod";
import type { SecretsCapability } from "../../capabilities.js";
import { resolveModel, createWebTools, stepAuth } from "../../llm.js";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { accessedNodesOf, defineStep, mediaOf, messagesOf, type StepContext, type StepRegistry, withAccessedNodes, withMedia, withMessages } from "../../core.js";
import { isCancelledError } from "../../run-control.js";
import { globToRegExp } from "../../closure.js";
import { parseStepRef } from "../../step-ref.js";
import { resolveStep } from "../registry.js";
import { usageFromResult, usageFromSteps, usageForCost, addUsage, emptyUsage, type TokenUsage } from "../../pricing.js";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute, sep } from "node:path";
import os from "node:os";

/**
 * Core AGENT step: a general tool-using agent loop (Vercel AI SDK
 * `ToolLoopAgent`). It explores a working directory (`cwd`) with a built-in set
 * of general-purpose tools and either:
 *   - calls a terminal `final_answer` tool and returns its text (`finalAnswer`
 *     mode — a free-form output contract the caller defines), or
 *   - produces a STRUCTURED object matching a JSON Schema (`schema` mode, via the
 *     SDK's `Output.object`), or
 *   - just returns the final assistant text (neither set).
 *
 * The tools are general (work on any codebase / working dir), so the step is
 * domain-agnostic: point it at a `cwd`, give it a `system` + `prompt`, and
 * optionally restrict the toolset with `toolFilter`. Anything domain-specific
 * (e.g. how to frame a particular workspace) lives in the CALLER's prompts.
 *
 * Built-in tools: repo_overview, file_summary, fulltext_search, bash,
 * str_replace_based_edit_tool (view/create/str_replace/insert files, sandboxed
 * to cwd), web_search and web_fetch (every provider, via aieo: native on
 * anthropic; Exa-backed search — needs EXA_API_KEY — and a guarded HTTP
 * fetch elsewhere). `final_answer` is added
 * automatically in finalAnswer mode and is always available regardless of
 * `toolFilter`.
 *
 * Provider-direct via the AI SDK, resolved through aieo (anthropic | openai |
 * google | openrouter | xai), lazy-loaded. Needs the provider's key in env
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY /
 * XAI_API_KEY) and `git` + `rg` on PATH for the repo tools. Output: { result, object?, steps, usage, cost }
 * (+ `messages` in the OUTPUT only when `returnMessages` is set). The full
 * session — system prompt, task prompt, every generated turn — is ALWAYS
 * recorded on the step's `step.end` event as `messages` (`buildSession` +
 * `withMessages`, the marker the runner lifts; invisible to templates and
 * downstream steps), so every agent transcript is in the run log without
 * bloating the data flow. `usage` is the aggregated
 * token counts across the whole agent loop
 * and `cost` is its dollar cost at the provider's rates (see ../../pricing.ts).
 */

// ── tool helpers (pure: take cwd as an argument) ───────────────────────────────
// Shell plumbing (capture/runCmd/runShell + env scrubbing) lives in shell.ts,
// shared with the chat builder's bash tool.

import { runCmd, runShell, maskSecretValues } from "../../shell.js";

/** Immediate subdirs of `cwd` that are git repos. */
function listRepos(cwd: string): string[] {
  if (!existsSync(cwd)) return [];
  return readdirSync(cwd, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(cwd, e.name, ".git")))
    .map((e) => e.name)
    .sort();
}

/** Directories that are build output / dependencies / generated noise: shown in
 *  the tree (so the agent knows they exist) but NEVER expanded — their contents
 *  would be high-token, low-signal. */
const NOISE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor",
  "coverage", "__pycache__", ".venv", "venv", ".next", ".nuxt", ".svelte-kit",
  ".turbo", ".cache", "migrations", ".gradle", "Pods", ".terraform", "__snapshots__",
]);

/** Default budgets for the adaptive repo map (see `repoTree`). */
const REPO_MAP_MAX_LINES = 200; // deepen until a depth busts this, then step back
const REPO_MAP_MAX_DEPTH = 8; // never go deeper than this regardless of budget
const REPO_MAP_MAX_CHARS = 12000; // final hard backstop

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: Set<string>;
}

/** Build a full directory tree from a flat path list. */
function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { dirs: new Map(), files: new Set() };
  for (const f of files) {
    const parts = f.split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = node.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: new Set() };
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.add(parts[parts.length - 1]);
  }
  return root;
}

/** Render the tree to `maxDepth` levels (root entries = level 1). A `NOISE_DIRS`
 *  directory is shown but never expanded; a directory beyond `maxDepth` is shown
 *  collapsed (name only). */
function renderTreeAtDepth(root: TreeNode, maxDepth: number): string {
  const lines: string[] = [];
  const walk = (node: TreeNode, level: number) => {
    for (const name of [...node.dirs.keys()].sort()) {
      lines.push(`${"  ".repeat(level - 1)}${name}/`);
      if (NOISE_DIRS.has(name)) continue; // collapse noise dirs
      if (level < maxDepth) walk(node.dirs.get(name)!, level + 1);
    }
    for (const name of [...node.files].sort()) {
      lines.push(`${"  ".repeat(level - 1)}${name}`);
    }
  };
  walk(root, 1);
  return lines.join("\n");
}

/**
 * Adaptive directory tree: always show the root (depth 1, every top-level dir +
 * file), then iteratively deepen — try depth 2, 3, … — keeping the deepest
 * rendering that stays under `maxLines`, and stepping back one when a depth busts
 * the budget. Noise dirs (build/deps/generated) are collapsed at every depth.
 * Pure + git-free so it's unit-testable. Returns the chosen text + depth.
 */
export function repoTree(
  files: string[],
  opts: { maxLines?: number; maxDepth?: number } = {},
): { text: string; depth: number } {
  const maxLines = opts.maxLines ?? REPO_MAP_MAX_LINES;
  const maxDepth = opts.maxDepth ?? REPO_MAP_MAX_DEPTH;
  const root = buildTree(files);

  let best = renderTreeAtDepth(root, 1); // root always shown, even if over budget
  let depth = 1;
  for (let d = 2; d <= maxDepth; d++) {
    const rendered = renderTreeAtDepth(root, d);
    if (rendered.split("\n").length > maxLines) break; // too many → keep previous depth
    best = rendered;
    depth = d;
  }
  return { text: best, depth };
}

/** A high-level map of the working dir: `git ls-files` across every git-repo
 *  subdir (prefixed), or — if `cwd` is itself a single repo / plain dir — its
 *  own tracked files. Rendered as an adaptive-depth tree (see `repoTree`), so
 *  even a huge monorepo stays within a token budget. No `tree` binary needed. */
async function getRepoMap(cwd: string): Promise<string> {
  const repos = listRepos(cwd);
  const files: string[] = [];
  if (repos.length) {
    for (const repo of repos) {
      try {
        const listing = await runCmd("git", ["ls-files"], join(cwd, repo), 10000, 500000);
        for (const f of listing.split("\n").filter(Boolean)) files.push(`${repo}/${f}`);
      } catch {
        /* skip a repo that fails to list */
      }
    }
  } else {
    try {
      const listing = await runCmd("git", ["ls-files"], cwd, 10000, 500000);
      for (const f of listing.split("\n").filter(Boolean)) files.push(f);
    } catch {
      /* not a git repo */
    }
  }
  if (!files.length) return "No tracked files found";

  const { text, depth } = repoTree(files);
  const header = `(${files.length} tracked files; tree shown to depth ${depth}; build/dependency/migration dirs collapsed)\n`;
  const out = header + text;
  return out.length > REPO_MAP_MAX_CHARS ? out.slice(0, REPO_MAP_MAX_CHARS) + "\n\n[... output truncated ...]" : out;
}

/** Max chars returned for a file summary before truncation. */
const FILE_SUMMARY_MAX_CHARS = 12000;

/** Max chars returned by `bash` before truncation. Matched to
 *  FILE_VIEW_MAX_CHARS: `cat`-ing a file through bash and `view`-ing it are the
 *  same retrieval, so they get the same budget — the agent legitimately needs
 *  large output (a lockfile, a full test log, a big JSON response). This is a
 *  context-budget cap, not a crash guard: the agent loop keeps every tool result
 *  in the message history for the whole run, so it is sized to one big
 *  retrieval (~125k–250k tokens at 2–4 chars/token — a 2.5-hour transcript)
 *  rather than going to a V8-string-limit-sized ceiling. Same default as
 *  exec's maxOutputChars. */
const BASH_MAX_CHARS = 500_000;

/** Is an executable named `bin` on PATH? Unix-style — the agent's tools already
 *  assume a unix env (git/rg/bash). Used to skip a tool whose CLI isn't present
 *  (e.g. `file_summary` when `stakgraph` isn't installed). */
function isOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(":");
  return dirs.some((d) => d && existsSync(join(d, bin)));
}

/** Structural summary of a file via the `stakgraph` AST CLI: `stakgraph "<file>"`
 *  in `cwd`. For code it returns imports + every function/class signature with
 *  line ranges + call edges; for config/data files it returns the content. Only
 *  used when `stakgraph` is on PATH (see `isOnPath`). */
async function stakgraphSummary(filePath: string, cwd: string): Promise<string> {
  if (!existsSync(join(cwd, filePath))) return "File not found";
  try {
    return await runCmd("stakgraph", [filePath], cwd, 15000, FILE_SUMMARY_MAX_CHARS);
  } catch (e) {
    return `Error summarizing file: ${(e as Error).message}`;
  }
}

/** Ripgrep across cwd, grouped by file with hit counts + line numbers. */
async function fulltextSearch(query: string, cwd: string): Promise<string> {
  if (!existsSync(cwd)) return "Working directory does not exist";
  let raw: string;
  try {
    raw = await runCmd("rg", ["--glob", "!dist", "--ignore-file", ".gitignore", "-n", query, "./"], cwd, 5000);
  } catch (e) {
    return `Error searching: ${(e as Error).message}`;
  }
  if (raw === "No matches found") return `No matches found for "${query}"`;
  const byFile: Record<string, number[]> = {};
  for (const line of raw.split("\n").filter(Boolean)) {
    const m = line.match(/^([^:]+):(\d+):/);
    if (m) (byFile[m[1]] ??= []).push(parseInt(m[2], 10));
  }
  const out = Object.entries(byFile)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([file, ls]) => `${ls.length}\t${file} (lines: ${ls.join(", ")})`)
    .join("\n");
  return out.length > 10000 ? out.slice(0, 10000) + "\n\n[... truncated ...]" : out;
}

/** A neutral listing of the working dir's immediate entries, prepended to the
 *  prompt so the agent knows the layout without a first tool call. Any
 *  interpretation of that layout belongs in the caller's `system`/`prompt`.
 *  An empty dir still gets its absolute path: a model told "write report.md
 *  into your working directory" otherwise guesses one (`/work`). */
export function buildPreamble(cwd: string): string {
  if (!existsSync(cwd)) return "";
  const entries = readdirSync(cwd, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  if (!entries.length) return `Working directory (${cwd}) is empty.`;
  return `Working directory (${cwd}) contains:\n` + entries.map((e) => `- ${e}`).join("\n");
}

// ── file editing tool (str_replace_based_edit_tool) ────────────────────────────

/** Max chars returned by a `view` before truncation. */
const FILE_VIEW_MAX_CHARS = 500_000;

/** The Anthropic text-editor tool's input shape (also used by the generic
 *  fallback for non-anthropic providers). All commands operate on a path that
 *  MUST resolve inside `cwd`. */
export interface TextEditInput {
  command: "view" | "create" | "str_replace" | "insert";
  path: string;
  file_text?: string;
  insert_line?: number;
  new_str?: string;
  insert_text?: string;
  old_str?: string;
  view_range?: number[];
}

/** Resolve a tool-supplied path against one or more allowed roots and refuse
 *  anything that escapes all of them (directory-traversal / absolute-path guard).
 *  Relative paths are resolved against the primary root (`roots[0]`). */
function resolveInCwd(p: string, roots: string | string[]): string {
  const rootList = (Array.isArray(roots) ? roots : [roots]).map((r) => resolve(r));
  const target = resolve(isAbsolute(p) ? p : join(rootList[0], p));
  if (!rootList.some((root) => target === root || target.startsWith(root + sep))) {
    throw new Error(`path "${p}" escapes the working directory`);
  }
  return target;
}

/**
 * Pure handler for the str_replace-based text editor tool: view / create /
 * str_replace / insert, sandboxed to `cwd`. Mirrors Anthropic's tool contract
 * (1-indexed line numbers, exactly-one-match str_replace, `insert_line` 0 =
 * top-of-file) so it backs both the provider-defined anthropic tool and the
 * generic fallback. Returns a human-readable string (errors as `Error: …`).
 */
export function textEdit(input: TextEditInput, roots: string | string[]): string {
  let target: string;
  try {
    target = resolveInCwd(input.path, roots);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }

  switch (input.command) {
    case "view": {
      if (!existsSync(target)) return "Error: File not found";
      if (statSync(target).isDirectory()) {
        const entries = readdirSync(target, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("."))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return entries.length ? entries.join("\n") : "(empty directory)";
      }
      const lines = readFileSync(target, "utf-8").split("\n");
      let start = 1;
      let end = lines.length;
      if (Array.isArray(input.view_range) && input.view_range.length === 2) {
        start = Math.max(1, input.view_range[0]);
        end = input.view_range[1] === -1 ? lines.length : input.view_range[1];
      }
      const out = lines
        .slice(start - 1, end)
        .map((l, i) => `${start + i}: ${l}`)
        .join("\n");
      return out.length > FILE_VIEW_MAX_CHARS
        ? out.slice(0, FILE_VIEW_MAX_CHARS) + "\n\n[... output truncated ...]"
        : out;
    }

    case "create": {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.file_text ?? "");
      return `Successfully created ${input.path}`;
    }

    case "str_replace": {
      if (!existsSync(target)) return "Error: File not found";
      const content = readFileSync(target, "utf-8");
      const old = input.old_str ?? "";
      const count = old ? content.split(old).length - 1 : 0;
      if (count === 0)
        return "Error: No match found for replacement. Please check your text and try again.";
      if (count > 1)
        return `Error: Found ${count} matches for replacement text. Please provide more context to make a unique match.`;
      writeFileSync(target, content.replace(old, input.new_str ?? ""));
      return "Successfully replaced text at exactly one location.";
    }

    case "insert": {
      if (!existsSync(target)) return "Error: File not found";
      const lines = readFileSync(target, "utf-8").split("\n");
      const at = input.insert_line ?? 0;
      if (at < 0 || at > lines.length)
        return `Error: insert_line ${at} is out of range (0-${lines.length})`;
      lines.splice(at, 0, input.insert_text ?? "");
      writeFileSync(target, lines.join("\n"));
      return `Successfully inserted text after line ${at}`;
    }

    default:
      return `Error: unknown command "${(input as { command?: string }).command}"`;
  }
}

// ── tool plumbing (agentTools + per-call run-event emit) ───────────────────────

/** Tool-call name from a registry step type: tool names can't contain slashes
 *  (`browser/click` → `browser_click`), so we sanitize for the LLM and map back. */
function toolNameFor(stepType: string): string {
  return stepType.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Expand `agentTools` entries against the registry: a name containing `*` is a
 * glob over registry step types (e.g. `"jarvis/*"` → every jarvis step), so a
 * whole namespace can be granted in one entry and new steps in it are picked
 * up automatically. Plain names pass through untouched (unknown ones still
 * warn in the tool-build loop). Duplicates collapse (first occurrence wins);
 * glob matches are sorted for a stable tool order.
 */
export function expandAgentTools(names: string[], registry: StepRegistry): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    let matches: string[];
    if (name.includes("*")) {
      const re = globToRegExp(name);
      matches = Object.keys(registry).filter((t) => re.test(t)).sort();
      if (matches.length === 0) {
        console.warn(`[agent] agentTools: pattern "${name}" matched no step types`);
      }
    } else {
      matches = [name];
    }
    for (const m of matches) {
      if (!seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
}

/**
 * Classify how a finalAnswer-mode tool loop ended. The AI SDK loop stops on
 * ANY turn with no tool call — including a mid-task narration ("now let's
 * copy this…"), observed live losing a 62-minute research session whose
 * deliverable needed two more tool calls.
 *  - "done"      — final_answer was called; nothing to salvage.
 *  - "nudge"     — stopped tool-lessly WITH budget remaining: resume the real
 *                  tool loop once (it can still finish file work), telling the
 *                  model to continue or call final_answer.
 *  - "exhausted" — the step budget is spent: only a no-tools forced answer
 *                  turn is possible.
 */
export function classifyFinalAnswerStop(
  finalFound: boolean,
  stepsUsed: number,
  maxSteps: number,
): "done" | "nudge" | "exhausted" {
  if (finalFound) return "done";
  return stepsUsed < maxSteps ? "nudge" : "exhausted";
}

/**
 * Schema-mode counterpart of that check. In structured mode the SDK loop
 * ends on ANY tool-less turn and parses that turn AS the object, so a model
 * that narrates or bails early hands back a schema-valid object whose
 * required strings are empty or filler. Observed live in a hill-climb: 3 of
 * 8 authoring generations returned `summary: ""` at 5-8 of 200 steps, and
 * one of them echoed a version it never got round to publishing — the
 * finalAnswer-mode nudge would have caught all three, but it never ran in
 * schema mode. Returns the names of top-level REQUIRED string properties
 * whose value is missing, blank, or a filler token; empty when the object
 * is usable (or the schema declares no required strings to check).
 */
const FILLER_VALUE = /^(placeholder|todo|tbd|n\/?a|none|null|unknown|string|\.\.\.|-+)[.!]?$/i;
export function degenerateSchemaFields(schema: unknown, output: unknown): string[] {
  const s = schema as { properties?: Record<string, { type?: unknown }>; required?: unknown } | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.required)) return [];
  const props = s.properties ?? {};
  const obj = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const bad: string[] = [];
  for (const key of s.required as unknown[]) {
    if (typeof key !== "string" || props[key]?.type !== "string") continue;
    const v = obj[key];
    if (typeof v !== "string" || !v.trim() || FILLER_VALUE.test(v.trim())) bad.push(key);
  }
  return bad;
}

/**
 * How many times a mid-stream CONNECTION failure may be resumed before the
 * step gives up. Each continuation replays the whole conversation so far, so
 * this is bounded work, not a spin: the step budget (`maxSteps`) still caps
 * total tool calls, and a genuinely dead endpoint fails the classifier's
 * transient test and throws on the first try.
 */
const MAX_STREAM_ERROR_CONTINUATIONS = 5;

/**
 * Distinguishes a mid-stream CONNECTION death from a real API failure.
 *
 * Once the response headers are in, the SDK's own request-level retry is out
 * of the picture — if the body stream then dies (undici raises a bare
 * `TypeError: terminated`), every result promise on the stream rejects, so an
 * unguarded loop discards the entire session. Observed live: a 34-tool-call
 * case-law research step lost ~12 minutes in when its streaming response
 * socket dropped.
 *
 * Only connection-level faults are resumable. Auth failures, 400s, and schema
 * errors are deterministic — retrying them just burns the budget, so they must
 * still throw. Aborts are excluded deliberately: a paused or cancelled run
 * surfaces as an abort, and resuming one would defeat run control.
 */
export function isTransientStreamError(err: unknown): boolean {
  // Run control wins over recovery: a cancelled run must die, not resume.
  // Checked up front and by identity, not by message sniffing, so a reworded
  // CancelledError can never start looking transient.
  if (isCancelledError(err)) return false;
  const seen = new Set<unknown>();
  for (let e: any = err; e && !seen.has(e); e = e.cause) {
    seen.add(e);
    const msg = String(e.message ?? e).toLowerCase();
    const code = String(e.code ?? "").toUpperCase();
    if (e.name === "AbortError" || msg.includes("abort")) return false;
    if (
      msg === "terminated" || // undici: response body stream died mid-flight
      msg.includes("fetch failed") ||
      msg.includes("socket hang up") ||
      msg.includes("premature close") ||
      msg.includes("connection closed") ||
      msg.includes("other side closed") ||
      code === "ECONNRESET" ||
      code === "ECONNABORTED" ||
      code === "EPIPE" ||
      code === "ETIMEDOUT" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT"
    )
      return true;
  }
  return false;
}

/** Sent as a user turn when resuming after a severed stream. The model cannot
 *  see where the cut fell, so it must be told what did and didn't happen. */
const STREAM_ERROR_NUDGE =
  "Your previous message was interrupted mid-stream by a transient connection error; " +
  "nothing after the interruption was received. Continue from where the conversation " +
  "actually is: any tool call you were about to make never executed — issue it now, and " +
  "do not repeat work already done or text already written.";

/** Truncate a tool's I/O for the run-event log (the full thing lives in the
 *  model transcript; the event log only needs a readable preview). */
function summarizeForEvent(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 1500 ? s.slice(0, 1500) + "\n[… truncated for event log …]" : s;
}

/**
 * Turn a list of registry step-types into AI-SDK tools the agent can call — the
 * "tools ARE steps" model. Each step's `input` Zod schema becomes the tool's
 * input schema and its `run` is the executor (validated against that schema).
 *
 * Does NOT emit run events itself — `wrapToolsWithEmit` does that uniformly for
 * built-ins AND registry tools, so there's a single shared call counter and one
 * code path. Pure + offline-testable (inject the `tool` factory + a fake
 * registry; no model/network). Unknown step-types are skipped. Returns a record
 * keyed by the sanitized tool name.
 *
 * Each tool's `toModelOutput` is `registryToolModelOutput`: a step that marks
 * its output with `withMedia` shows the model the media beside the JSON.
 */
export function buildRegistryTools(
  names: string[] | undefined,
  registry: StepRegistry | undefined,
  ctx: StepContext | undefined,
  // The AI SDK `tool()` factory. Typed loosely (like the built-in tools, which
  // cast `inputSchema` to any) — the SDK's Tool generics over-constrain here.
  toolFactory: (def: any) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!names?.length || !registry) return out;
  for (const stepType of expandAgentTools(names, registry)) {
    const def = registry[stepType];
    if (!def) {
      console.warn(`[agent] agentTools: unknown step type "${stepType}" — skipping`);
      continue;
    }
    out[toolNameFor(stepType)] = toolFactory({
      description: def.description ?? `Run the "${stepType}" step.`,
      inputSchema: def.input,
      execute: async (input: unknown, options?: { strutToolPath?: string }) => {
        let parsed: unknown;
        try {
          parsed = def.input.parse(input ?? {});
        } catch (e) {
          return `Error: invalid input for "${stepType}": ${(e as Error).message}`;
        }
        // Run the step with the agent's ctx (leaf tool-steps reach
        // ctx.services etc.). The nesting/emit is added by wrapToolsWithEmit,
        // which also threads this call's event path in via `strutToolPath` —
        // adopting it as the child ctx path makes any events the step itself
        // emits (e.g. a nested `agent` step's own tool calls) nest UNDER this
        // call's span instead of appearing as flat siblings of it.
        const base: StepContext = ctx ??
          ({ runId: "", path: "", scope: {}, input: undefined, emit: (async () => {}) as any, services: undefined });
        const childCtx: StepContext = options?.strutToolPath
          ? { ...base, agentTool: true, path: options.strutToolPath }
          : { ...base, agentTool: true };
        return def.run(parsed, childCtx);
      },
      toModelOutput: ({ output }: { output: unknown }) => registryToolModelOutput(output),
    });
  }
  return out;
}

/**
 * What the model sees of a registry tool's result. An unmarked output gets
 * the AI SDK's own default — a string as text, anything else as JSON — so
 * nothing changes for existing tools. An output marked with `withMedia`
 * becomes a content result: the same JSON as a text part, then one file part
 * per media entry (bytes sent as base64), which is how a `browser/screenshot`
 * step shows the model the frame it took. The `execute` result itself stays
 * the plain marked object, so the event log, templates and `maskDeep` see
 * only the JSON; the recorded session (`step.end.messages`) keeps what the
 * model saw, file parts included.
 */
export function registryToolModelOutput(output: unknown): ToolResultOutput {
  const media = mediaOf(output);
  if (!media) {
    return typeof output === "string" ? { type: "text", value: output } : { type: "json", value: toJsonValue(output) };
  }
  return {
    type: "content",
    value: [
      { type: "text", text: JSON.stringify(output) },
      ...media.map((m) => ({
        type: "file" as const,
        data: { type: "data" as const, data: typeof m.data === "string" ? m.data : Buffer.from(m.data).toString("base64") },
        mediaType: m.mediaType,
        ...(m.filename ? { filename: m.filename } : {}),
      })),
    ],
  };
}

/** The SDK's own coercion of a tool result to JSON (`undefined` → null). */
function toJsonValue(value: unknown): Extract<ToolResultOutput, { type: "json" }>["value"] {
  if (value === undefined) return null;
  const s = JSON.stringify(value);
  return s === undefined ? null : JSON.parse(s);
}

/**
 * Wrap EVERY tool's `execute` (built-ins + agentTools) so each call emits a
 * nested `step.start`/`step.end` (or `step.error`) run event at
 * `<agentPath>/NNN-<tool>` with `stepType: "tool:<name>"`. A single shared
 * counter (`NNN`) gives the calls a globally-ordered, sortable path — that's
 * what makes the otherwise-opaque agent loop visible in the events panel / run
 * drill-down. Mutates `tools` in place.
 *
 * No-op when there's no runner ctx (in-code/test) or no path. Skips
 * `final_answer` (terminal, noisy) and any tool with no function `execute`
 * (provider-executed tools like anthropic `web_search`). Output is truncated in
 * the event only (the model still sees the full result) — except the
 * provenance marker: a result marked with `withAccessedNodes` gets its node
 * refs lifted verbatim onto the `step.end` event as `nodes`, the one part of
 * tool output that must survive into the log untruncated because it is data
 * for the graph projector (`ACCESSED` edges), not a preview for humans.
 */
/** `maskSecretValues` lives in shell.ts (shared with the exec step); re-exported
 *  here because it is part of the agent step's tested surface. */
export { maskSecretValues };

/** Recursively mask secret values in every string leaf of a tool result.
 *  Tool outputs are JSON-ish (they get persisted to run events), so a plain
 *  object/array/primitive walk covers them. */
export function maskDeep(value: unknown, values: string[]): unknown {
  if (!values.length) return value;
  if (typeof value === "string") return maskSecretValues(value, values);
  // Rebuilding a container drops its non-enumerable markers — carry them over.
  if (Array.isArray(value)) return carryMarkers(value.map((x) => maskDeep(x, values)), value, values);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, values);
    return carryMarkers(out, value, values);
  }
  return value;
}

/** Re-attach the markers a rebuilt container lost: node refs and media as
 *  they are (ids and image bytes, not secrets); a session masked like
 *  everything else — a tool result echoing `$KEY` sits inside it too. */
function carryMarkers<T>(rebuilt: T, original: unknown, values: string[]): T {
  const session = messagesOf(original);
  return withMedia(
    withMessages(
      withAccessedNodes(rebuilt, accessedNodesOf(original) ?? []),
      session ? (maskDeep(session, values) as unknown[]) : undefined,
    ),
    mediaOf(original),
  );
}

/** The transcript recorded for an agent session (`RunEvent.messages`): the
 *  system prompt, the task prompt as the model saw it (cwd preamble included),
 *  then every generated turn — AI SDK model messages, the shape a log store
 *  holds. Self-contained on purpose: a reader needs nothing else. */
export function buildSession(system: string, prompt: string, turns: unknown[]): unknown[] {
  return [{ role: "system", content: system }, { role: "user", content: prompt }, ...turns];
}

/**
 * Wrap every tool's `execute` so its RESULT is masked before the model (and
 * the event log — this runs inside `wrapToolsWithEmit`'s wrapping) sees it.
 * The complement to `secretsEnv`: values reach the bash SUBPROCESS, and this
 * guarantees they never travel back into the model's context via any tool
 * output — `echo $KEY`, `env`, a curl error echoing the URL, or a file the
 * shell wrote and the editor tool later views. Mutates `tools` in place.
 *
 * What it cannot do: stop the shell itself from SENDING `$KEY` somewhere
 * (egress under prompt injection). That residual is accepted and documented
 * (EVOLVE_SPEC §4.4) — grant secretsEnv only to narrow research agents.
 */
export function wrapToolsWithMask(tools: Record<string, any>, secretValues: string[]): void {
  if (!secretValues.length) return;
  for (const t of Object.values(tools)) {
    const orig = t?.execute;
    if (typeof orig !== "function") continue;
    t.execute = async (input: unknown, opts: unknown) =>
      maskDeep(await (orig as (i: unknown, o: unknown) => Promise<unknown>)(input, opts), secretValues);
  }
}

export function wrapToolsWithEmit(tools: Record<string, any>, ctx: StepContext | undefined): void {
  if (!ctx?.emit || !ctx.path) return;
  const basePath = ctx.path;
  const emit = ctx.emit as unknown as (e: Record<string, unknown>) => Promise<void>;
  let calls = 0;
  for (const [name, t] of Object.entries(tools)) {
    if (name === "final_answer") continue;
    const orig = t?.execute;
    if (typeof orig !== "function") continue;
    t.execute = async (input: unknown, opts: unknown) => {
      const n = ++calls;
      const path = `${basePath}/${String(n).padStart(3, "0")}-${name}`;
      const startedAt = Date.now();
      await emit({ type: "step.start", path, stepType: `tool:${name}`, input });
      try {
        // Thread this call's event path to the tool (registry tools adopt it
        // as their child ctx path, so nested emits land under this span).
        const optsWithPath =
          typeof opts === "object" && opts !== null
            ? { ...(opts as Record<string, unknown>), strutToolPath: path }
            : { strutToolPath: path };
        const out = await (orig as (i: unknown, o: unknown) => Promise<unknown>)(input, optsWithPath);
        const nodes = accessedNodesOf(out);
        const messages = messagesOf(out); // a sub-agent's session
        await emit({
          type: "step.end",
          path,
          stepType: `tool:${name}`,
          output: summarizeForEvent(out),
          durationMs: Date.now() - startedAt,
          ...(nodes ? { nodes } : {}),
          ...(messages ? { messages } : {}),
        });
        return out;
      } catch (e) {
        await emit({ type: "step.error", path, stepType: `tool:${name}`, error: { message: (e as Error).message } });
        throw e;
      }
    };
  }
}

const EXAMPLE = `- id: fix
  type: agent
  config:
    cwd: "{{ input.repo }}"
    system: "You are a careful engineer. Make the smallest change that fixes the problem."
    prompt: "The test suite fails with:\\n{{ test.stderr }}\\nFind the cause and fix it."
    finalAnswer: "A short report: what was wrong, what you changed, how you verified it."
    model: sonnet`;

export default defineStep({
  type: "agent",
  description:
    `Autonomous tool-using sub-agent (AI SDK ToolLoopAgent) over a working dir: it explores and edits files with built-in tools (repo_overview, fulltext_search, bash, str_replace_based_edit_tool; web_search + web_fetch on any provider — native on anthropic, elsewhere Exa search via EXA_API_KEY plus a guarded HTTP fetch; file_summary when the \`stakgraph\` CLI is on PATH), plus any registry steps exposed through agentTools. ` +
    `Use it for open-ended work a fixed DAG can't express — diagnose and fix a codebase, drive an app, research a question — and always when a hard stop must still produce a deliverable; prefer the loop step for a fixed repeat. ` +
    `Keep arithmetic and format conversion out of its head: expose a tool step for it (e.g. timestamp hh:mm:ss / mm:ss / seconds → seconds, offsets, end times) or return a typed schema that code post-processes. ` +
    `It returns a free-form report (finalAnswer), a structured object (schema), or the final text. Needs the provider's key (secret store or env) and git + rg on PATH. Output: { result, object?, steps, usage, cost } (+ messages when returnMessages).\n\n` +
    EXAMPLE,
  input: z.object({
    cwd: z.string().describe("working directory the tools operate in"),
    system: z.string().describe("system prompt / agent persona"),
    prompt: z.string().describe("the user task driving the agent"),
    finalAnswer: z
      .string()
      .optional()
      .describe("if set, a `final_answer` tool is added with this description; its output is the result. Omit when using `schema`."),
    schema: z
      .any()
      .optional()
      .describe("if set, a JSON Schema for STRUCTURED output (Output.object); the step returns the object. Mutually exclusive with finalAnswer."),
    toolFilter: z
      .array(z.string())
      .default([])
      .describe("subset of built-in tool names to enable; empty = all. (final_answer is always available in finalAnswer mode.)"),
    agentTools: z
      .array(z.string())
      .default([])
      .describe(
        "registry step TYPES to expose as additional LLM tools (the 'tools are steps' model, e.g. ['gitsee/read-logs']). Entries may be glob patterns over step types ('jarvis/*' grants the whole namespace; new steps in it are picked up automatically). Each step's input schema becomes the tool schema and its run() is the executor, called with a nested ctx so every tool call emits a step.start/step.end run event (visible in the events panel). Merged ON TOP of the built-ins (not subject to toolFilter). Unknown types are skipped. Requires the runner-populated ctx.registry.",
      ),
    secretsEnv: z
      .array(z.string())
      .default([])
      .describe(
        "secret NAMES (from the deployment's secret store) to inject as env vars into the bash tool's subprocess — the agent writes `$NAME` in commands (e.g. curl auth headers) and the shell expands it at exec time. The VALUE never enters the prompt, the model's context, or the event log: bash gets it via env only, and every tool output is masked before the model sees it. Grant narrowly (a dedicated research sub-agent), never to a drafting/producing agent. Residual risk (accepted): a prompt-injected agent can still SEND $NAME somewhere — masking stops leakage into context/logs, not egress.",
      ),
    model: z
      .string()
      .optional()
      .meta({
        description:
          "model id, aieo alias ('sonnet', 'gemini', 'grok', 'kimi', 'glm'), or 'provider/id' ('openrouter/deepseek/deepseek-v3' — OpenRouter models as openrouter/org/model); the provider is inferred from it when `provider` is omitted",
        // The step editor offers the deployment's model catalog (GET /llm/models).
        suggest: "llm-models",
      }),
    provider: z
      .string()
      .optional()
      .describe("anthropic | openai | google | openrouter | xai — usually omitted (inferred from `model`)"),
    maxSteps: z.number().int().positive().default(40).describe("cap on tool-loop turns before the agent must answer"),
    cacheTtl: z
      .enum(["5m", "1h"])
      .default("5m")
      .describe(
        "anthropic prompt-cache lifetime. 1h costs 2x per cache write (vs 1.25x) but survives gaps over 5 minutes between turns — use it when a tool call can run long (a sub-agent granted via agentTools, a slow build or test run), or the session re-writes its whole context after the wait",
      ),
    returnMessages: z
      .boolean()
      .default(false)
      .describe(
        "ALSO include the full session (`messages`) in the OUTPUT. The session is always recorded on this step's step.end event; this puts it in the data flow too, where it bloats run.json, templates and a parent agent's tool result — turn on only for a fork/sub-agent that needs the transcript as data.",
      ),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const { ToolLoopAgent, Output, tool, isStepCount, hasToolCall, jsonSchema, streamText } = await import("ai");

    // Model/provider resolution via aieo (shared with mcp) through strut's
    // resolver (src/llm.ts): friendly aliases ("sonnet", "grok"), canonical
    // ids ("openrouter/moonshotai/kimi-k2.6"), provider inference, keys via
    // the secrets boundary (secret store → env), LLM gateway routing and a
    // timeout-wrapped fetch. The PROVIDER is needed now (provider-specific
    // tools below) and is keyless; the key + client are resolved LAST.
    const { canonicalModelName, computeSessionCost } = await import("aieo");
    const modelName = cfg.model ?? process.env["STRUT_LLM_MODEL"];
    const providerHint = cfg.provider ?? process.env["STRUT_LLM_PROVIDER"];
    const { provider } = canonicalModelName(modelName, providerHint);

    // Anthropic-only extras: the provider-defined text
    // editor (the model is specially trained on its schema; we supply the
    // execute that performs the edit inside cfg.cwd), and EPHEMERAL PROMPT
    // CACHING at the call level (the request's top-level `cache_control`:
    // Anthropic's automatic caching moves the breakpoint to the end of the
    // conversation every step, so each step reads everything before it and
    // writes only what the last step added). `cacheTtl` picks the lifetime. Other
    // providers fall back to the generic editor tool. (Web search/fetch
    // are NOT provider-gated — see the web tools after model resolution.)
    let textEditorTool: any;
    let providerOptions: any;
    if (provider === "anthropic") {
      const { anthropic } = await import("@ai-sdk/anthropic");
      textEditorTool = anthropic.tools.textEditor_20250728({
        execute: async (input: TextEditInput) => textEdit(input, [cfg.cwd, os.tmpdir()]),
      });
      providerOptions = { anthropic: { cacheControl: { type: "ephemeral", ttl: cfg.cacheTtl } } };
    }

    // ── secretsEnv: resolve named secrets → bash subprocess env ────────────
    // Values are fetched here (in code, via the secrets capability) and go two
    // places ONLY: the bash child env, and the mask list. Never the prompt.
    const secretEnv: Record<string, string> = {};
    const missingSecretNames: string[] = [];
    if (cfg.secretsEnv.length) {
      const secrets = (ctx?.services as { secrets?: { get(name: string): Promise<string | undefined> } } | undefined)
        ?.secrets;
      if (!secrets || typeof secrets.get !== "function") {
        throw new Error("agent: secretsEnv requires the secrets capability (ctx.services.secrets)");
      }
      for (const name of cfg.secretsEnv) {
        const v = await secrets.get(name);
        if (v) secretEnv[name] = v;
        else missingSecretNames.push(name);
      }
    }
    // Very short values would mask common substrings all over the output;
    // real credentials are long. (A <6-char "secret" is not protectable anyway.)
    const secretValues = Object.values(secretEnv).filter((v) => v.length >= 6);
    // Tell the model what's available — by NAME only — in the bash tool's own
    // description (not the prompt: descriptions travel with the tool).
    const secretsNote = cfg.secretsEnv.length
      ? " Credential env vars available in this shell (values injected at exec time and masked in all output — write $NAME, never expect to see the value): " +
        (Object.keys(secretEnv).join(", ") || "none") +
        "." +
        (missingSecretNames.length
          ? ` Requested but NOT in the secret store (the $VAR will be empty — degrade gracefully and report it): ${missingSecretNames.join(", ")}.`
          : "")
      : "";

    // Built-in tools (operate on cfg.cwd). `inputSchema` cast to any to stop the
    // SDK's tool() from deeply inferring the zod type (TS2589 in strict builds).
    const allTools: Record<string, any> = {
      repo_overview: tool({
        description:
          "Get a high-level map of the codebase under the working dir (tracked files across any sub-repos). Use it to understand the layout and find where functionality lives.",
        inputSchema: z.object({}) as any,
        execute: async () => {
          try {
            return await getRepoMap(cfg.cwd);
          } catch {
            return "Could not retrieve repository map";
          }
        },
      }),
      fulltext_search: tool({
        description:
          'Search the codebase for a term (e.g. "process.env."). Returns files with the term, occurrence counts, and line numbers. Use it to find env vars, integrations, and how central a symbol is.',
        inputSchema: z.object({ query: z.string().describe("The term to search for") }) as any,
        execute: async ({ query }: { query: string }) => {
          try {
            return await fulltextSearch(query, cfg.cwd);
          } catch (e) {
            return `Search failed: ${e}`;
          }
        },
      }),
      bash: tool({
        description:
          "Execute a bash command inside the working dir. Use for listing dirs, reading files (cat/head), inspecting manifests/lockfiles/docker files, running installs/builds, and anything the other tools don't cover. Long-running commands are allowed (up to a 10-minute timeout); a command that never exits (e.g. a dev server) will block until killed at the timeout." +
          secretsNote,
        inputSchema: z.object({ command: z.string().describe("The bash command to execute") }) as any,
        execute: async ({ command }: { command: string }) => {
          try {
            if (!existsSync(cfg.cwd)) return "Working directory does not exist";
            // 10-minute timeout so the agent can run real installs/builds (not just
            // quick inspection). Note: a non-terminating process (a dev server)
            // still blocks until killed at this timeout.
            return await runShell(command, cfg.cwd, 600_000, BASH_MAX_CHARS, secretEnv);
          } catch (e) {
            return `Command execution failed: ${e}`;
          }
        },
      }),
    };
    // file_summary is the stakgraph AST CLI — only offer it when stakgraph is on
    // PATH; otherwise the agent reads files via `bash` (cat/head).
    if (isOnPath("stakgraph")) {
      allTools.file_summary = tool({
        description:
          "Get a STRUCTURAL summary of a file (relative to the working dir): for code, its imports + every function/class signature with line ranges + call edges; for config/data files, the content. Backed by the stakgraph AST parser — prefer it over cat for understanding code files.",
        inputSchema: z.object({
          file_path: z.string().describe("Path to the file, relative to the working dir"),
        }) as any,
        execute: async ({ file_path }: { file_path: string }) => {
          try {
            return await stakgraphSummary(file_path, cfg.cwd);
          } catch {
            return "Bad file path";
          }
        },
      });
    }
    // File editing (str_replace_based_edit_tool): view/create/str_replace/insert,
    // sandboxed to cfg.cwd. For anthropic use the provider-defined tool (the
    // model is specially trained on it); other providers get an identical generic
    // tool. The key MUST be `str_replace_based_edit_tool` for the anthropic case.
    allTools.str_replace_based_edit_tool = textEditorTool
      ? textEditorTool
      : tool({
          description:
            "View and edit text files (sandboxed to the working dir). Commands: " +
            '`view` (path, optional view_range [start,end]), `create` (path, file_text), ' +
            "`str_replace` (path, old_str must match EXACTLY once, new_str), " +
            "`insert` (path, insert_line — 0 = top of file, insert_text).",
          inputSchema: z.object({
            command: z.enum(["view", "create", "str_replace", "insert"]),
            path: z.string(),
            file_text: z.string().optional(),
            insert_line: z.number().int().optional(),
            new_str: z.string().optional(),
            insert_text: z.string().optional(),
            old_str: z.string().optional(),
            view_range: z.array(z.number().int()).optional(),
          }) as any,
          execute: async (input: TextEditInput) => textEdit(input, [cfg.cwd, os.tmpdir()]),
        });

    // Apply toolFilter (empty = all). Unknown names are ignored.
    const filter = cfg.toolFilter ?? [];
    const tools: Record<string, any> = {};
    for (const [name, t] of Object.entries(allTools)) {
      if (!filter.length || filter.includes(name)) tools[name] = t;
    }

    // Registry-backed tools (the "tools are steps" model). Merged ON TOP of the
    // (filtered) built-ins — explicitly requested, so not subject to toolFilter.
    // Needs the runner-populated ctx.registry; absent (in-code/test) → no-op.
    // A pinned grant (`clip/shout@v1`) is loaded once here so the sync
    // lookup below finds it (src/step-ref.ts).
    if (ctx?.registry) for (const name of cfg.agentTools ?? []) if (parseStepRef(name).version) await resolveStep(ctx.registry, name);
    Object.assign(tools, buildRegistryTools(cfg.agentTools, ctx?.registry, ctx, tool));

    // Output mode: schema (structured) vs finalAnswer (terminal tool) vs text.
    const useSchema = cfg.schema != null;
    if (useSchema && cfg.finalAnswer) {
      throw new Error("agent: set EITHER `schema` (structured output) OR `finalAnswer` (terminal tool), not both.");
    }
    if (!useSchema && cfg.finalAnswer) {
      tools.final_answer = tool({
        description: cfg.finalAnswer,
        inputSchema: z.object({ answer: z.string() }) as any,
        execute: async ({ answer }: { answer: string }) => answer,
      });
    }

    // Mask secret values out of EVERY tool result — must wrap INSIDE the emit
    // wrapper (i.e. be applied first) so run events also only ever see masked
    // output. Covers indirect paths too: bash writes a secret to a file, the
    // editor tool views it — still masked.
    wrapToolsWithMask(tools, secretValues);

    // Emit a nested run event per tool call (built-ins + agentTools) so every
    // iteration is visible in the UI events panel / run drill-down. No-op when
    // run outside the runner (no ctx). Must come AFTER final_answer is added so
    // it's uniformly considered (and skipped).
    wrapToolsWithEmit(tools, ctx);

    const stopWhen = !useSchema && cfg.finalAnswer
      ? [hasToolCall("final_answer"), isStepCount(cfg.maxSteps)]
      : [isStepCount(cfg.maxSteps)];

    // Resolved LAST (after all config validation): the key lookup throws when
    // no key is configured — a config error should surface before a
    // missing-key error. `maxOutputTokens` is a provider-derived infra
    // constant (see pricing.ts) — NOT step config: a workflow author never
    // picks this, and the SDK's 4096 default truncates large tool calls
    // mid-JSON.
    const resolved = await resolveModel({
      model: modelName,
      provider: providerHint,
      secrets: (ctx?.services as { secrets?: SecretsCapability } | undefined)?.secrets,
      // Where to send the call and how to attribute it (plans/mothership-cost-control.md §1).
      ...stepAuth(ctx),
    });
    const model: any = resolved.model;
    const maxOutputTokens = resolved.maxOutputTokens;
    // Dollar cost at aieo's rates (per-model OpenRouter rates once
    // loadModelPricing() has run; provider defaults otherwise).
    const costOf = (u: TokenUsage) => computeSessionCost(resolved.provider, usageForCost(u), resolved.modelId);

    // Web tools — web_search + web_fetch on EVERY provider (aieo: native on
    // anthropic; Exa search + guarded HTTP fetch elsewhere — and everywhere
    // when the call is routed through a gateway, see createWebTools). Built
    // here, not with the other built-ins, because the native ones need the
    // resolved key. Subject to toolFilter like any built-in, and the shims
    // get the same mask + emit wrapping so their calls show up as run events
    // (the native ones have no execute and are skipped by both wrappers).
    const web = await createWebTools({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      secrets: (ctx?.services as { secrets?: SecretsCapability } | undefined)?.secrets,
      searchMaxUses: 3,
      routed: resolved.routed,
    });
    const webTools: Record<string, any> = {};
    for (const [name, t] of Object.entries(web.tools)) {
      if (!filter.length || filter.includes(name)) webTools[name] = t;
    }
    wrapToolsWithMask(webTools, secretValues);
    wrapToolsWithEmit(webTools, ctx);
    Object.assign(tools, webTools);
    // Steps that completed BEFORE a mid-stream failure are unreachable through
    // the stream's result promises — `steps`, `responseMessages`, `usage` and
    // `text` all reject with the stream error — so the only way to keep that
    // work is to bank each step as it finishes. Cumulative across resume
    // attempts, which is exactly what a continuation needs to replay.
    const bankedSteps: any[] = [];
    const bankedMessages: any[] = [];
    let bankedUsage = emptyUsage();
    // Shared by the main loop and the premature-stop nudge continuation.
    const onStepEnd = (sf: any) => {
      bankedSteps.push(sf);
      // Per-step in v7 (v6 made these cumulative, so banking them duplicated history).
      bankedMessages.push(...((sf.response?.messages ?? []) as any[]));
      bankedUsage = addUsage(bankedUsage, usageFromResult(sf.usage, sf.providerMetadata));
      // A length finish means the generation was TRUNCATED at the output
      // cap — a cut-off tool call never executes, so the loop dies with no
      // error. Make the cause loud instead of silent.
      if (sf.finishReason === "length") {
        console.warn(
          `[agent] TRUNCATED: generation hit maxOutputTokens=${maxOutputTokens} (finish=length, out:${sf.usage?.outputTokens ?? "?"}). A cut-off tool call never executed. Raise STRUT_MAX_OUTPUT_TOKENS or split the write.`,
        );
      }
      if (!Array.isArray(sf.content)) return;
      for (const c of sf.content) {
        if (c.type === "tool-call" && c.toolName !== "final_answer") {
          console.log("[agent] TOOL CALL:", c.toolName, ":", JSON.stringify(c.input));
        }
      }
    };
    // Cooperative boundary BETWEEN tool calls (RUN_CONTROL_SPEC §4) — the
    // single highest-value checkpoint in long agent sessions: a pause parks
    // before the next LLM call starts (the in-flight one finishes and is
    // journaled); a cancel stops the session here. `ctx.control` is the
    // runner's unit-scoped view, so a parked agent counts as quiesced.
    const prepareStep = async () => {
      await ctx?.control?.checkpoint();
      return undefined;
    };
    const agent = new ToolLoopAgent({
      model,
      instructions: cfg.system,
      tools,
      maxOutputTokens,
      stopWhen,
      ...(providerOptions ? { providerOptions } : {}),
      ...(useSchema ? { output: Output.object({ schema: jsonSchema(cfg.schema) }) } : {}),
      prepareStep,
      onStepEnd,
    });

    const preamble = buildPreamble(cfg.cwd);
    const startTime = Date.now();
    // STREAM, don't generate: a long drafting turn (multi-minute, many
    // thousands of output tokens) produces zero bytes on a non-streaming
    // connection until it completes, and intermediaries sever it as idle —
    // seen live as "other side closed" at ~3min, killing whole runs.
    // Streaming keeps bytes flowing; we drain the stream and then await the
    // aggregate fields, which have the same shapes generate() returned.
    const basePrompt = preamble ? `${preamble}\n\n${cfg.prompt}` : cfg.prompt;
    // Streaming keeps the socket alive but cannot make it immortal: the body
    // can still die mid-flight, and when it does the SDK's result promises all
    // reject, so an unguarded read throws away every tool call the session
    // already made. Resume instead — replay the banked conversation and let the
    // model carry on. Only connection faults qualify; see isTransientStreamError.
    let streamErrorContinuations = 0;
    let res!: {
      steps: any;
      responseMessages: any[];
      usage: any;
      text: any;
      output: any;
    };
    for (;;) {
      const resuming = streamErrorContinuations > 0;
      // Budget already spent by banked steps must not be handed out again.
      const remaining = Math.max(1, cfg.maxSteps - bankedSteps.length);
      const runner = resuming
        ? new ToolLoopAgent({
            model,
            instructions: cfg.system,
            tools,
            maxOutputTokens,
            stopWhen:
              !useSchema && cfg.finalAnswer
                ? [hasToolCall("final_answer"), isStepCount(remaining)]
                : [isStepCount(remaining)],
            ...(providerOptions ? { providerOptions } : {}),
            ...(useSchema ? { output: Output.object({ schema: jsonSchema(cfg.schema) }) } : {}),
            prepareStep,
            onStepEnd,
          })
        : agent;
      const attempt = resuming
        ? await runner.stream({
            messages: [
              // responseMessages holds only generated turns, so the task
              // itself has to lead the replay.
              { role: "user", content: basePrompt },
              ...(bankedMessages as any[]),
              { role: "user", content: STREAM_ERROR_NUDGE },
            ] as any,
          })
        : await runner.stream({ prompt: basePrompt });
      let streamError: unknown;
      await attempt.consumeStream({ onError: (e: unknown) => { streamError = e; } });
      if (!streamError) {
        res = {
          steps: await attempt.steps,
          // v7: `response` is final-step only; `responseMessages` spans every step.
          responseMessages: await attempt.responseMessages,
          usage: await attempt.usage,
          text: await attempt.text,
          output: useSchema ? await (attempt as any).output : undefined,
        };
        break;
      }
      if (
        !isTransientStreamError(streamError) ||
        streamErrorContinuations >= MAX_STREAM_ERROR_CONTINUATIONS ||
        bankedSteps.length >= cfg.maxSteps
      ) {
        throw streamError;
      }
      streamErrorContinuations++;
      // v7 wraps the socket fault ("Failed to process successful response");
      // the root cause is the useful part of the log line.
      let rootCause: any = streamError;
      while (rootCause?.cause) rootCause = rootCause.cause;
      console.warn(
        `[agent] stream severed after ${bankedSteps.length} banked step(s) (${
          (streamError as Error).message
        }${rootCause !== streamError ? `: ${rootCause?.message ?? rootCause}` : ""}); resuming ${streamErrorContinuations}/${MAX_STREAM_ERROR_CONTINUATIONS}.`,
      );
    }
    // A resumed run's final attempt only knows its own segment — the banked
    // record spans every attempt, so it is the honest view of the whole step.
    const resumedFromStreamError = streamErrorContinuations > 0;

    const steps = resumedFromStreamError ? bankedSteps : (res.steps ?? []);
    // Total LLM turns across the whole session — the nudge continuation
    // (finalAnswer mode, below) folds its turns in.
    let stepsUsed = steps.length;
    // The generated turns so far; the nudge / forced continuations below
    // append theirs (and the user turns that drove them), so `messages` is the
    // whole conversation after the task prompt.
    const messages = resumedFromStreamError ? bankedMessages : (res.responseMessages ?? []);
    /** The step's output with the whole session recorded on its `step.end`
     *  (`withMessages` — the runner lifts it; templates, a parent agent's tool
     *  result and run.json never see it) and, only on request, in the output. */
    const finish = (out: Record<string, unknown>) => {
      const session = buildSession(cfg.system, basePrompt, messages);
      return withMessages(cfg.returnMessages ? { ...out, messages: session } : out, session);
    };

    // Token usage + cost across the WHOLE agent loop: the per-step sum banked
    // by onStepEnd, across resume attempts (per step, because only a step's
    // usage keeps the provider's raw counts — pricing.ts). `provider` drives
    // the rate table. Mutable so a forced final-answer turn (below) can be folded in.
    let usage = bankedUsage;
    let cost = costOf(usage);
    console.log(
      `[agent] tokens in:${usage.inputTokens} cacheRead:${usage.cacheReadTokens} cacheWrite:${usage.cacheWriteTokens} out:${usage.outputTokens} → $${cost.toFixed(4)}`,
    );

    // Structured mode: return the typed object.
    if (useSchema) {
      let object = res.output;
      let text = res.text;
      // PREMATURE stop, schema flavour: the loop ended on a tool-less turn
      // with budget remaining and the parsed object has required strings
      // that are empty or filler. Same remedy as the finalAnswer nudge
      // below — resume the REAL tool loop once (it can still publish or
      // verify whatever it skipped) and demand a complete structured
      // answer. A second degenerate stop is returned as-is: the caller's
      // own fallbacks (usableSummary, version resolution) take it from there.
      const bad = degenerateSchemaFields(cfg.schema, object);
      if (bad.length && stepsUsed < cfg.maxSteps) {
        console.warn(
          `[agent] Structured answer left required field(s) empty/filler (${bad.join(", ")}) at ${stepsUsed}/${cfg.maxSteps} steps; nudging the loop once.`,
        );
        try {
          const nudger = new ToolLoopAgent({
            model,
            instructions: cfg.system,
            tools,
            maxOutputTokens,
            // At least a few turns even when the stop came near the cap.
            stopWhen: [isStepCount(Math.max(4, cfg.maxSteps - stepsUsed))],
            ...(providerOptions ? { providerOptions } : {}),
            output: Output.object({ schema: jsonSchema(cfg.schema) }),
            prepareStep,
            onStepEnd,
          });
          const nudge = {
            role: "user" as const,
            content:
              "Your last message ended your run and was parsed as your FINAL structured answer, but it left " +
              `required field(s) empty or filler: ${bad.join(", ")}. That answer is what the harness harvests — ` +
              "an empty field there wastes the whole run. If work remains (something you still had to publish, " +
              "create, or verify), continue it with tool calls now. Then finish with a complete structured answer " +
              "that fills EVERY required field with real values: never a placeholder, never an empty string.",
          };
          const nudged = await nudger.stream({
            // responseMessages holds only generated turns — the task leads.
            messages: [{ role: "user", content: basePrompt }, ...(messages as any[]), nudge] as any,
          });
          let nudgeError: unknown;
          await nudged.consumeStream({ onError: (e: unknown) => { nudgeError = e; } });
          if (nudgeError) throw nudgeError;
          const nudgedSteps = (await nudged.steps) ?? [];
          stepsUsed += nudgedSteps.length;
          // The recorded session keeps the nudge that drove these turns.
          messages.push(nudge, ...(((await nudged.responseMessages) ?? []) as any[]));
          const nu = usageFromSteps(nudgedSteps);
          usage = addUsage(usage, nu);
          cost += costOf(nu);
          // The continuation may have done real work (a publish) before
          // answering, so its object is the fresher one — keep it unless it
          // is WORSE than what we already had.
          const nudgedObject = await (nudged as any).output;
          const stillBad = degenerateSchemaFields(cfg.schema, nudgedObject);
          if (stillBad.length <= bad.length) {
            object = nudgedObject;
            text = await nudged.text;
          }
          if (stillBad.length) {
            console.warn(`[agent] nudged structured answer still has empty/filler field(s): ${stillBad.join(", ")}`);
          }
        } catch (e) {
          console.warn("[agent] schema nudge continuation failed:", (e as Error).message);
        }
      }
      console.log(`[agent] completed in ${Date.now() - startTime}ms (${stepsUsed} steps, structured)`);
      return finish({ result: text, object, steps: stepsUsed, usage, cost });
    }

    // finalAnswer / text mode: extract the final_answer tool output, else last text.
    let final = "";
    let lastText = "";
    for (const step of steps) {
      for (const item of step.content) {
        if (item.type === "text" && item.text?.trim()) lastText = item.text.trim();
      }
    }
    if (cfg.finalAnswer) {
      const extractFinal = (fromSteps: any[]): string => {
        for (const step of [...fromSteps].reverse()) {
          const fa = step.content.find(
            (c: any) => c.type === "tool-result" && c.toolName === "final_answer",
          );
          if (fa) return String((fa as { output?: unknown }).output ?? "");
        }
        return "";
      };
      final = extractFinal(steps);

      // PREMATURE text-only stop: the model narrated ("now let's copy this…")
      // instead of calling a tool, which ends the SDK loop even with budget
      // remaining — observed live losing a 62-minute research session whose
      // deliverable needed two more tool calls. Unlike the no-tools forced
      // turn below, resuming the REAL tool loop can still finish that work:
      // continue the session ONCE with the remaining budget and a nudge to
      // either keep working or call final_answer. A second tool-less stop
      // falls through to the forced turn / last-text fallback as before.
      if (classifyFinalAnswerStop(!!final, stepsUsed, cfg.maxSteps) === "nudge") {
        console.warn(
          `[agent] Loop ended tool-lessly at ${stepsUsed}/${cfg.maxSteps} steps without final_answer; nudging the loop once.`,
        );
        try {
          const nudger = new ToolLoopAgent({
            model,
            instructions: cfg.system,
            tools,
            maxOutputTokens,
            stopWhen: [
              hasToolCall("final_answer"),
              // At least a few turns even when the stop came near the cap —
              // finishing file work takes more than one call.
              isStepCount(Math.max(4, cfg.maxSteps - stepsUsed)),
            ],
            ...(providerOptions ? { providerOptions } : {}),
            prepareStep,
            onStepEnd,
          });
          const nudge = {
            role: "user" as const,
            content:
              "You stopped by sending a message without any tool call — that ends your run, and you have NOT called final_answer. " +
              "If the task is genuinely complete, verify your deliverables now and call final_answer. Otherwise continue the work " +
              "with tool calls. Do not stop again without calling final_answer.\n\n" +
              cfg.finalAnswer,
          };
          const nudged = await nudger.stream({
            // The session's own user prompt first — responseMessages holds
            // only the generated turns, and the continuation needs the task.
            messages: [{ role: "user", content: basePrompt }, ...(messages as any[]), nudge] as any,
          });
          let nudgeError: unknown;
          await nudged.consumeStream({ onError: (e: unknown) => { nudgeError = e; } });
          if (nudgeError) throw nudgeError;
          const nudgedSteps = (await nudged.steps) ?? [];
          stepsUsed += nudgedSteps.length;
          // The recorded session keeps the nudge that drove these turns.
          messages.push(nudge, ...(((await nudged.responseMessages) ?? []) as any[]));
          for (const step of nudgedSteps) {
            for (const item of step.content) {
              if (item.type === "text" && item.text?.trim()) lastText = item.text.trim();
            }
          }
          final = extractFinal(nudgedSteps);
          const nu = usageFromSteps(nudgedSteps);
          usage = addUsage(usage, nu);
          cost += costOf(nu);
        } catch (e) {
          console.warn("[agent] nudge continuation failed:", (e as Error).message);
        }
      }

      // The loop ended (budget exhausted, or the nudge also stopped tool-lessly)
      // WITHOUT calling final_answer, so we'd otherwise return a stray reasoning
      // sentence and lose the whole (expensive) exploration. Salvage it: force
      // ONE no-tools turn that must emit the final answer now, continuing the
      // full session.
      if (!final) {
        console.warn("[agent] No final_answer tool call; forcing a final-answer turn.");
        try {
          // Streamed for the same severed-connection reason as the main loop —
          // this single turn emits the ENTIRE final answer.
          const forcedPrompt = {
            role: "user" as const,
            content: `You have used your entire exploration budget — do NOT call any tools. Using everything you learned above, produce the final answer NOW.\n\n${cfg.finalAnswer}`,
          };
          const forced = streamText({
            model,
            ...(providerOptions ? { providerOptions } : {}),
            messages: [...(messages as any[]), forcedPrompt],
          });
          let forcedError: unknown;
          await forced.consumeStream({ onError: (e: unknown) => { forcedError = e; } });
          if (forcedError) throw forcedError;
          // The recorded session keeps this turn too.
          messages.push(forcedPrompt, ...((((await forced.response) as any)?.messages ?? []) as any[]));
          const ft = ((await forced.text) ?? "").trim();
          if (ft) {
            final = ft;
            const fu = usageFromSteps(await forced.steps);
            usage = addUsage(usage, fu);
            cost += costOf(fu);
          }
        } catch (e) {
          console.warn("[agent] forced final-answer turn failed:", (e as Error).message);
        }
        if (!final && lastText) {
          final = `${lastText}\n\n(Note: model did not invoke final_answer; using last reasoning text.)`;
        }
      }
    } else {
      final = res.text || lastText;
    }

    console.log(`[agent] completed in ${Date.now() - startTime}ms (${stepsUsed} steps)`);
    return finish({ result: final, steps: stepsUsed, usage, cost });
  },
});
