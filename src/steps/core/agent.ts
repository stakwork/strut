import { z } from "zod";
import type { SecretsCapability } from "../../capabilities.js";
import { resolveModel, createWebTools, stepAuth, type ResolvedModel } from "../../llm.js";
import { idProblem, type OpenSession, type SessionsCapability } from "../../session-store.js";
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
 *   - calls that same tool with a STRUCTURED object matching a JSON Schema
 *     (`schema` mode: the schema is the tool's input, the step returns the
 *     object), or
 *   - just returns the final assistant text (neither set).
 *
 * Both answer modes end on a TOOL CALL, never on an output grammar over the
 * loop. The SDK's `Output.object` (Anthropic `output_config.format`) forbids
 * any free text, so at the "I'm done" moment a model that wants to narrate
 * cannot, and substitutes the cheapest tool call instead — observed live on
 * Sonnet 5.5 as `true` / `echo done` repeated until the step cap, and
 * reproduced direct to the provider. A terminal tool leaves the text free;
 * the grammar is only used for the forced final-answer turn — one request,
 * no loop, the model told not to call tools — where it is safe.
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
 * automatically in finalAnswer and schema mode and is always available
 * regardless of `toolFilter`.
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
 *
 * With `session` set the step CONTINUES a thread (plans/agent-sessions.md):
 * it holds that session from the first model call to the commit, starts from
 * the thread's system prompt and messages, and appends this turn on success.
 * The run log then records the turn; the session store holds the thread.
 */

// ── tool helpers (pure: take cwd as an argument) ───────────────────────────────
// Shell plumbing (capture/runCmd/runShell + env scrubbing) lives in shell.ts,
// shared with the chat builder's bash tool.

import { runCmd, runShellProcess, killGroups, maskSecretValues, type ProcessResult } from "../../shell.js";

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

/** A file this tool must not read as text: a NUL byte in its first 8 KB (git's
 *  own test). Read as UTF-8, a PNG is ~its size in replacement characters, and
 *  the model then carries that in every later request. */
function binaryFile(target: string): string | null {
  const head = readFileSync(target).subarray(0, 8192);
  return head.includes(0) ? `Error: binary file (${statSync(target).size} bytes) — this tool reads text only` : null;
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
      const binary = binaryFile(target);
      if (binary) return binary;
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
      const binary = binaryFile(target);
      if (binary) return binary;
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
      const binary = binaryFile(target);
      if (binary) return binary;
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
 * The answer a terminal loop produced: the OUTPUT of the newest executed
 * `final_answer` call (its text in finalAnswer mode, the object in schema
 * mode), or undefined when no step called it. A call the tool refused is a
 * `tool-error`, not a result — it does not count, so the model answers it.
 */
export function finalAnswerOf(steps: Array<{ content?: any[] }>): unknown {
  for (const step of [...steps].reverse()) {
    const fa = step.content?.find((c: any) => c.type === "tool-result" && c.toolName === "final_answer");
    if (fa) return (fa as { output?: unknown }).output;
  }
  return undefined;
}

/**
 * Top-level `required` properties of a JSON Schema that `input` leaves out.
 * The SDK's `jsonSchema()` validates nothing by itself, so this is the one
 * check the `final_answer` tool makes before accepting an object: a missing
 * required field is refused as a tool error the model must answer, instead
 * of reaching the caller as `undefined`.
 */
export function missingRequired(schema: unknown, input: unknown): string[] {
  const s = schema as { required?: unknown } | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.required)) return [];
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return (s.required as unknown[]).filter((k): k is string => typeof k === "string" && obj[k] === undefined);
}

/**
 * The no-op loop guard. A model that has finished but is not producing its
 * answer tends to mark time with the cheapest tool call it has — `true`,
 * `echo done` — and once a few identical turns sit in the history it repeats
 * them: three swarm runs of the `job` workflow burned 65, 90 and 493 calls
 * that way (2026-09-30). After this many consecutive steps that are ONE
 * identical tool call with an identical result, the next step offers only
 * `final_answer` (no tools at all in text mode), so the only moves left are
 * to answer or to stop. Identical RESULTS keep a legitimate poll (same
 * command, changing output) out of it.
 */
export const NOOP_LOOP_STREAK = 3;

/**
 * How many trailing steps are the same single (tool, input, output). A step
 * with no tool call, several, or a call without a result ends the streak.
 */
export function identicalTailCalls(steps: Array<{ content?: any[] }>): number {
  let n = 0;
  let key: string | undefined;
  for (const step of [...steps].reverse()) {
    const content = step.content ?? [];
    const calls = content.filter((c: any) => c.type === "tool-call");
    if (calls.length !== 1) break;
    const result = content.find((c: any) => c.type === "tool-result" && c.toolCallId === calls[0].toolCallId);
    if (!result) break;
    const k = JSON.stringify([calls[0].toolName, calls[0].input, result.output]);
    if (key !== undefined && k !== key) break;
    key = k;
    n++;
  }
  return n;
}

/** What `final_answer` is for in schema mode — the tool's description, and
 *  the contract every nudge restates. */
const SCHEMA_ANSWER_CONTRACT =
  "Your FINAL answer: the structured object the caller asked for. Call final_answer exactly once, when the work is done — it ends your run. " +
  "Fill every required field with real values, never a placeholder or an empty string.";

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

/**
 * Read a stream to its end and return the error that ended it, if any.
 *
 * `consumeStream`'s `onError` hears only a stream that BROKE (a socket that
 * died mid-body). A request the provider refused — a 400 on a later step — or
 * a throw out of `prepareStep` (a cancel) is not a broken stream to the SDK:
 * it arrives as an `error` part, the stream closes normally and `steps`
 * resolves with what was banked, which reads exactly like a model that
 * stopped. Observed 2026-09-29: a 400 after one tool call was nudged, then
 * answered by a forced turn, and the step returned a result.
 */
export async function streamFailure(result: {
  stream: AsyncIterable<{ type: string; error?: unknown }>;
}): Promise<unknown> {
  let failure: unknown;
  try {
    for await (const part of result.stream) {
      if (part.type === "error") failure ??= part.error ?? new Error("the stream reported an error");
    }
  } catch (e) {
    failure ??= e ?? new Error("the stream broke");
  }
  return failure;
}

/** Thrown when a stream ended in an error that no fallback may paper over. */
export class AgentStreamError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AgentStreamError";
  }
}

/**
 * The error the step fails with for a stream that ended in one. A cancel
 * passes through untouched — run control reads it by identity. Anything else
 * is said in full: a run log records an error's `message` only, and the SDK
 * keeps a refused request's status and body on properties of the error (or
 * of the one it wraps: `cause`, a RetryError's `lastError`).
 */
export function streamError(err: unknown, stepsDone: number): unknown {
  if (isCancelledError(err)) return err;
  let http = "";
  const seen = new Set<unknown>();
  for (let e: any = err; e && typeof e === "object" && !seen.has(e); e = e.cause ?? e.lastError) {
    seen.add(e);
    if (e.statusCode == null && typeof e.responseBody !== "string") continue;
    const body = typeof e.responseBody === "string" ? e.responseBody.trim() : "";
    const shown = body.length > 2000 ? `${body.slice(0, 2000)}… [${body.length} chars]` : body;
    http = ` (HTTP ${e.statusCode ?? "?"}${shown ? `: ${shown}` : ""})`;
    break;
  }
  const said = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return new AgentStreamError(`agent failed after ${stepsDone} step(s): ${said}${http}`, err);
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

/** The share of the model's window past which a thread takes no more turns. */
const SESSION_FULL_AT = 0.9;

/**
 * Open `id` for one turn: take its lock, read the thread, and refuse a turn
 * the thread cannot take. Every refusal releases the lock.
 *
 *  - `session_mismatch:` — the provider, and whether calls go through a
 *    gateway, are fixed by the first turn: another provider cannot read the
 *    thread's thinking and provider-executed tool blocks, and the gateway
 *    cannot round-trip the native web tools a direct turn may have used.
 *  - `session_full:` — the last turn left the thread over `SESSION_FULL_AT`
 *    of the model's window: the next one would outgrow it mid-loop. Said
 *    before any model call, not as a provider 400 on every later turn.
 */
export async function openSession(
  id: string,
  ctx: StepContext | undefined,
  resolved: Pick<ResolvedModel, "provider" | "routed" | "contextLimit">,
): Promise<OpenSession> {
  const sessions = (ctx?.services as { sessions?: SessionsCapability } | undefined)?.sessions;
  if (!sessions || typeof sessions.open !== "function") {
    throw new Error("agent: session requires the sessions capability (ctx.services.sessions)");
  }
  const session = await sessions.open(id, { runId: ctx?.runId ?? "", path: ctx?.path ?? "" });
  const first = session.turns[0];
  const last = session.turns[session.turns.length - 1];
  let refusal = "";
  if (first && (first.provider !== resolved.provider || first.routed !== resolved.routed)) {
    const how = (routed: boolean) => (routed ? "through the gateway" : "direct");
    refusal =
      `session_mismatch: session "${id}" began on ${first.provider} (${how(first.routed)}); ` +
      `this turn resolved to ${resolved.provider} (${how(resolved.routed)})`;
  } else if (last?.context && last.context.used > SESSION_FULL_AT * resolved.contextLimit) {
    refusal =
      `session_full: session "${id}" holds ${last.context.used} tokens of a ${resolved.contextLimit}-token window ` +
      `(over ${SESSION_FULL_AT * 100}%) — no room for another turn. Start a new session.`;
  }
  if (refusal) {
    session.release();
    throw new Error(refusal);
  }
  return session;
}

/** The tool set with every `execute` removed: the same definitions on the
 *  wire — the prefix a replayed thinking block is bound to, and the prompt
 *  cache's — and a call the model makes anyway runs nothing. (The twin of the
 *  compaction summarizer's, plans/compaction.md §3.) */
export function stripExecute<T extends Record<string, unknown>>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (t && typeof t === "object" && "execute" in t) {
      const { execute: _execute, ...rest } = t as Record<string, unknown>;
      out[name] = rest;
    } else {
      out[name] = t;
    }
  }
  return out as T;
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

/** The `bash` tool's result text for a finished command — the contract the
 *  tool has always had (exit 0 → stdout, plus a `[stderr]` section when there
 *  was any; exit 1 with no stderr → stdout or "No matches found", the grep
 *  idiom; anything else → `Command execution failed: …`), with the two ways a
 *  command is STOPPED named: the run cancelling (the loop's next checkpoint
 *  raises, so the model never reads this one) and `bashTimeoutMs`. Both kill
 *  the process group; whatever the command printed before that rides along. */
export function bashResult(res: ProcessResult, timeoutMs: number, cancelled: boolean): string {
  const printed = res.stderr || res.stdout;
  if (cancelled) return `Command cancelled: the run is being cancelled${printed ? `\n${printed}` : ""}`;
  if (res.timedOut) {
    return `Command execution failed: Error: Command timed out after ${timeoutMs}ms (its process group was killed)${printed ? `\n${printed}` : ""}`;
  }
  if (res.code === 0) return res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : "");
  if (res.code === 1 && !res.stderr) return res.stdout || "No matches found";
  const how = res.code === null ? `killed by ${res.signal}` : String(res.code);
  return `Command execution failed: Error: Command failed (${how}): ${res.stderr || res.stdout || "Unknown error"}`;
}

export default defineStep({
  type: "agent",
  description:
    `Autonomous tool-using sub-agent (AI SDK ToolLoopAgent) over a working dir: it explores and edits files with built-in tools (repo_overview, fulltext_search, bash, str_replace_based_edit_tool; web_search + web_fetch on any provider — native on anthropic, elsewhere Exa search via EXA_API_KEY plus a guarded HTTP fetch; file_summary when the \`stakgraph\` CLI is on PATH), plus any registry steps exposed through agentTools. ` +
    `Use it for open-ended work a fixed DAG can't express — diagnose and fix a codebase, drive an app, research a question — and always when a hard stop must still produce a deliverable; prefer the loop step for a fixed repeat. ` +
    `Keep arithmetic and format conversion out of its head: expose a tool step for it (e.g. timestamp hh:mm:ss / mm:ss / seconds → seconds, offsets, end times) or return a typed schema that code post-processes. ` +
    `It returns a free-form report (finalAnswer), a structured object (schema), or the final text. Needs the provider's key (secret store or env) and git + rg on PATH. Output: { result, object?, steps, usage, cost } (+ messages when returnMessages; + session: { id, turn, offset } when session is set).\n\n` +
    EXAMPLE,
  input: z.object({
    cwd: z.string().describe("working directory the tools operate in"),
    system: z.string().describe("system prompt / agent persona"),
    prompt: z.string().describe("the user task driving the agent"),
    session: z
      .string()
      .optional()
      .describe(
        'CONTINUE a conversation across runs: an id the CALLER supplies, usually "{{ input.session }}" (a uuid). The agent starts from that thread — its system prompt, fixed by the thread\'s first turn (this step\'s `system` is ignored after), and every earlier message — and appends this turn when it succeeds; a failed or cancelled turn appends nothing. Omit for a one-shot agent. Ids are GLOBAL: every run of every workflow naming the same id shares ONE thread, so a literal ("janitor-daily") is right only for an agent that should remember forever. Give each chained agent of a workflow its own id ("{{ input.session }}/review"); an agent without `session` starts cold every run. One turn at a time per id (a second fails with `session_busy:`). Letters, digits and ". _ -" in `/`-separated segments. Turns minutes apart want cacheTtl: 1h. To carry the FILES along too, give git/checkout a `workdir`.',
      ),
    finalAnswer: z
      .string()
      .optional()
      .describe("if set, a `final_answer` tool is added with this description; its text is the result. Omit when using `schema`."),
    schema: z
      .any()
      .optional()
      .describe("if set, a JSON Schema for STRUCTURED output: it becomes the `final_answer` tool's input, and the step returns the object the model called it with. Mutually exclusive with finalAnswer."),
    toolFilter: z
      .array(z.string())
      .default([])
      .describe("subset of built-in tool names to enable; empty = all, ['none'] = no built-ins (only agentTools). (final_answer is always available in finalAnswer and schema mode.)"),
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
    maxSteps: z.number().int().positive().default(200).describe("cap on tool-loop turns before the agent must answer"),
    bashTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(300_000)
      .describe(
        "cap on ONE `bash` command, in ms (default 5 minutes): at it the command's whole process group is killed and the tool reports the timeout. Raise it for a workflow whose commands run real builds or test suites.",
      ),
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
    const { ToolLoopAgent, Output, tool, isStepCount, jsonSchema, streamText } = await import("ai");

    // Model/provider resolution via aieo (shared with mcp) through strut's
    // resolver (src/llm.ts): friendly aliases ("sonnet", "grok"), canonical
    // ids ("openrouter/moonshotai/kimi-k2.6"), provider inference, keys via
    // the secrets boundary (secret store → env), LLM gateway routing and a
    // timeout-wrapped fetch. The PROVIDER is needed now (provider-specific
    // tools below) and is keyless; the key + client are resolved LAST.
    const { canonicalModelName, computeSessionCost } = await import("aieo");
    if (cfg.session !== undefined) {
      const problem = idProblem(cfg.session);
      if (problem) throw new Error(`agent: session "${cfg.session}" ${problem}`);
      // As a tool the MODEL would be choosing the id: a read door into any
      // thread whose name it can guess.
      if (ctx?.agentTool) throw new Error("agent: a sub-agent (an agent called as a tool) cannot take a `session`");
    }
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

    // What a `bash` command leaves running in its process group once it has
    // returned — a dev server started in the background, a browser behind
    // `| tail` — is ended with the run (shell.ts `killGroups`), never left to
    // the container: on swarm38 (2026-10-01) the headless Chromes job runs
    // had left behind held gigabytes.
    const leftovers = new Set<number>();
    ctx?.onRunEnd?.(() => killGroups(leftovers));

    // What the model is told a `bash` command may take (the tool result names
    // the real number when one is killed).
    const bashBudget =
      cfg.bashTimeoutMs >= 60_000
        ? `${Math.round(cfg.bashTimeoutMs / 60_000)} minute${Math.round(cfg.bashTimeoutMs / 60_000) === 1 ? "" : "s"}`
        : cfg.bashTimeoutMs >= 1000
          ? `${Math.round(cfg.bashTimeoutMs / 1000)} seconds`
          : `${cfg.bashTimeoutMs} ms`;

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
          `Execute a bash command inside the working dir. Use for listing dirs, reading files (cat/head), inspecting manifests/lockfiles/docker files, running installs/builds, and anything the other tools don't cover. One command may run for ${bashBudget}: at that point its whole process group is killed and the tool reports the timeout. So a program that never exits (a dev server), or a pipeline whose helper processes keep the pipe open (a browser behind \`| tail\`), is started in the background with its output redirected to a file, then polled.` +
          secretsNote,
        inputSchema: z.object({ command: z.string().describe("The bash command to execute") }) as any,
        execute: async ({ command }: { command: string }) => {
          if (!existsSync(cfg.cwd)) return "Working directory does not exist";
          // One command is one unit of run control (RUN_CONTROL_SPEC §4): watch
          // the run's state while it runs and kill the PROCESS GROUP the moment
          // the run starts cancelling — the exec step's treatment — so a cancel
          // never waits out a hung browser or build. The loop's next
          // prepareStep checkpoint then raises the canonical CancelledError.
          // Pause is left alone (in-flight leaves finish).
          const ac = new AbortController();
          const control = ctx?.control;
          const watch = control
            ? setInterval(() => {
                if (control.state === "cancelling") ac.abort();
              }, 200)
            : undefined;
          let res: ProcessResult;
          try {
            res = await runShellProcess(command, {
              cwd: cfg.cwd,
              timeoutMs: cfg.bashTimeoutMs,
              maxOutputChars: BASH_MAX_CHARS,
              env: secretEnv,
              signal: ac.signal,
              onLeftover: (pgid) => void leftovers.add(pgid),
            });
          } catch (e) {
            return `Command execution failed: ${e}`;
          } finally {
            if (watch) clearInterval(watch);
          }
          return bashResult(res, cfg.bashTimeoutMs, ac.signal.aborted);
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

    // Output mode: schema (structured) vs finalAnswer (free text) vs plain
    // text. The first two end on the SAME terminal tool — see the header for
    // why the schema is the tool's input and never an output grammar.
    const useSchema = cfg.schema != null;
    if (useSchema && cfg.finalAnswer) {
      throw new Error("agent: set EITHER `schema` (structured output) OR `finalAnswer` (terminal tool), not both.");
    }
    const terminal = useSchema || !!cfg.finalAnswer;
    /** The output contract, restated by every nudge. */
    const contract: string = useSchema ? SCHEMA_ANSWER_CONTRACT : (cfg.finalAnswer ?? "");
    if (terminal) {
      tools.final_answer = useSchema
        ? tool({
            description: SCHEMA_ANSWER_CONTRACT,
            inputSchema: jsonSchema(cfg.schema) as any,
            execute: async (input: unknown) => {
              const missing = missingRequired(cfg.schema, input);
              if (missing.length) {
                throw new Error(`final_answer refused: missing required field(s): ${missing.join(", ")}. Call it again with EVERY required field.`);
              }
              return input;
            },
          })
        : tool({
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

    /** The terminal condition: the newest step EXECUTED final_answer. (The
     *  SDK's `hasToolCall` would also stop on a call the tool refused.) */
    const finalAnswered = ({ steps }: { steps: any[] }) => finalAnswerOf(steps.slice(-1)) !== undefined;
    const stopWhen = terminal ? [finalAnswered, isStepCount(cfg.maxSteps)] : [isStepCount(cfg.maxSteps)];

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

    // A session is held from here to the commit (or the failure): one turn at
    // a time per thread. Its system prompt is the first turn's, replayed
    // verbatim — with its messages it heads every request, and the prompt
    // cache (and thinking blocks bound to the prefix) need it byte for byte.
    const session = cfg.session ? await openSession(cfg.session, ctx, resolved) : undefined;
    const system = session?.system ?? cfg.system;
    if (session?.system != null && session.system !== cfg.system) {
      console.warn(`[agent] session "${session.id}" keeps its first turn's system prompt; this step's \`system\` is ignored.`);
    }
    try {
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
      // The context after the latest model call: what it read plus what it wrote.
      let contextUsed = 0;
      // Shared by the main loop and the premature-stop nudge continuation.
      const onStepEnd = (sf: any) => {
        bankedSteps.push(sf);
        // Per-step in v7 (v6 made these cumulative, so banking them duplicated history).
        bankedMessages.push(...((sf.response?.messages ?? []) as any[]));
        const stepUsage = usageFromResult(sf.usage, sf.providerMetadata);
        bankedUsage = addUsage(bankedUsage, stepUsage);
        contextUsed = stepUsage.inputTokens + stepUsage.cacheReadTokens + stepUsage.cacheWriteTokens + stepUsage.outputTokens;
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
      const prepareStep = async ({ steps: soFar }: { steps: any[] }) => {
        await ctx?.control?.checkpoint();
        // The no-op loop guard (NOOP_LOOP_STREAK): the model is marking time.
        if (identicalTailCalls(soFar) >= NOOP_LOOP_STREAK) {
          const call = soFar.at(-1)?.content?.find((c: any) => c.type === "tool-call");
          const only = terminal ? ["final_answer"] : [];
          console.warn(
            `[agent] ${NOOP_LOOP_STREAK} identical tool calls in a row (${call?.toolName} ${JSON.stringify(call?.input ?? null).slice(0, 120)}); ` +
              `this step offers ${only.length ? "only final_answer" : "no tools"}.`,
          );
          return { activeTools: only };
        }
        return undefined;
      };
      const agent = new ToolLoopAgent({
        model,
        instructions: system,
        tools,
        maxOutputTokens,
        stopWhen,
        ...(providerOptions ? { providerOptions } : {}),
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
      // What leads every request of this turn: the thread so far, then the
      // task. `responseMessages` holds only generated turns, so each
      // continuation below (stream resume, nudge) restates it.
      const prior = (session?.messages ?? []) as any[];
      const head = [...prior, { role: "user" as const, content: basePrompt }];
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
      };
      for (;;) {
        const resuming = streamErrorContinuations > 0;
        // Budget already spent by banked steps must not be handed out again.
        const remaining = Math.max(1, cfg.maxSteps - bankedSteps.length);
        const runner = resuming
          ? new ToolLoopAgent({
              model,
              instructions: system,
              tools,
              maxOutputTokens,
              stopWhen: terminal ? [finalAnswered, isStepCount(remaining)] : [isStepCount(remaining)],
              ...(providerOptions ? { providerOptions } : {}),
              prepareStep,
              onStepEnd,
            })
          : agent;
        const attempt = resuming
          ? await runner.stream({
              messages: [...head, ...(bankedMessages as any[]), { role: "user", content: STREAM_ERROR_NUDGE }] as any,
            })
          : prior.length
            ? await runner.stream({ messages: head as any })
            : await runner.stream({ prompt: basePrompt });
        const failure = await streamFailure(attempt);
        if (failure === undefined) {
          res = {
            steps: await attempt.steps,
            // v7: `response` is final-step only; `responseMessages` spans every step.
            responseMessages: await attempt.responseMessages,
            usage: await attempt.usage,
            text: await attempt.text,
          };
          break;
        }
        if (
          !isTransientStreamError(failure) ||
          streamErrorContinuations >= MAX_STREAM_ERROR_CONTINUATIONS ||
          bankedSteps.length >= cfg.maxSteps
        ) {
          throw streamError(failure, bankedSteps.length);
        }
        streamErrorContinuations++;
        // v7 wraps the socket fault ("Failed to process successful response");
        // the root cause is the useful part of the log line.
        let rootCause: any = failure;
        while (rootCause?.cause) rootCause = rootCause.cause;
        console.warn(
          `[agent] stream severed after ${bankedSteps.length} banked step(s) (${
            (failure as Error).message
          }${rootCause !== failure ? `: ${rootCause?.message ?? rootCause}` : ""}); resuming ${streamErrorContinuations}/${MAX_STREAM_ERROR_CONTINUATIONS}.`,
        );
      }
      // A resumed run's final attempt only knows its own segment — the banked
      // record spans every attempt, so it is the honest view of the whole step.
      const resumedFromStreamError = streamErrorContinuations > 0;

      // The continuations below (nudge, forced final answer) are SALVAGE: one
      // that fails is given up and the next fallback takes over. Not so for a
      // request the provider refused, or a cancel — the conversation is what
      // was refused and the next fallback would send it again, and a cancelled
      // run asks nothing more. Those fail the step, as in the main loop.
      const drain = async (continuation: Parameters<typeof streamFailure>[0]) => {
        const failure = await streamFailure(continuation);
        if (failure === undefined) return;
        throw isTransientStreamError(failure) ? failure : streamError(failure, bankedSteps.length);
      };
      const giveUp = (what: string, e: unknown) => {
        if (e instanceof AgentStreamError || isCancelledError(e)) throw e;
        console.warn(`[agent] ${what} failed:`, (e as Error).message);
      };

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
       *  result and run.json never see it) and, only on request, in the output.
       *  In a thread, what is recorded is THIS TURN (the system prompt, the
       *  task, what was generated): the turn is committed to the session
       *  store, which holds the rest, and the output says where it sits. */
      const finish = async (out: Record<string, unknown>) => {
        const turn = buildSession(system, basePrompt, messages);
        if (session) {
          const line = await session.commit({
            system,
            messages: turn.slice(1),
            record: {
              workflow: (ctx?.path ?? "").split("/")[0] ?? "",
              runId: ctx?.runId ?? "",
              path: ctx?.path ?? "",
              ...(ctx?.actor ? { actor: ctx.actor } : {}),
              ...(ctx?.principal ? { principal: ctx.principal } : {}),
              provider: resolved.provider,
              model: resolved.name,
              routed: resolved.routed,
              usage: out["usage"],
              cost: out["cost"] as number,
              ...(contextUsed ? { context: { used: contextUsed, limit: resolved.contextLimit } } : {}),
            },
          });
          out = { ...out, session: { id: session.id, turn: line.turn, offset: line.offset } };
        }
        return withMessages(cfg.returnMessages ? { ...out, messages: turn } : out, turn);
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

      // The last text the model wrote: the plain-text result, and the
      // last-resort fallback for a finalAnswer loop that never answered.
      let lastText = "";
      const noteText = (fromSteps: any[]) => {
        for (const step of fromSteps) {
          for (const item of step.content ?? []) {
            if (item.type === "text" && item.text?.trim()) lastText = item.text.trim();
          }
        }
      };
      noteText(steps);

      if (!terminal) {
        console.log(`[agent] completed in ${Date.now() - startTime}ms (${stepsUsed} steps)`);
        return await finish({ result: res.text || lastText, steps: stepsUsed, usage, cost });
      }

      // Both answer modes end on final_answer: its text (finalAnswer) or the
      // caller's object (schema). Everything below is SALVAGE for a loop that
      // ended without it — or, in schema mode, with a degenerate one.
      let answer: unknown = finalAnswerOf(steps);

      /** Resume the REAL tool loop once from the whole conversation so far,
       *  with `nudge` as the next user turn — the model can still finish file
       *  work before answering. Banks the new steps' usage, cost, text and
       *  messages; returns them. */
      const continueLoop = async (nudge: { role: "user"; content: string }, budget: number) => {
        const nudger = new ToolLoopAgent({
          model,
          instructions: system,
          tools,
          maxOutputTokens,
          // At least a few turns even when the stop came near the cap —
          // finishing file work takes more than one call.
          stopWhen: [finalAnswered, isStepCount(Math.max(4, budget))],
          ...(providerOptions ? { providerOptions } : {}),
          prepareStep,
          onStepEnd,
        });
        const nudged = await nudger.stream({ messages: [...head, ...(messages as any[]), nudge] as any });
        await drain(nudged);
        const nudgedSteps = (await nudged.steps) ?? [];
        stepsUsed += nudgedSteps.length;
        // The recorded session keeps the nudge that drove these turns.
        messages.push(nudge, ...(((await nudged.responseMessages) ?? []) as any[]));
        noteText(nudgedSteps);
        const nu = usageFromSteps(nudgedSteps);
        usage = addUsage(usage, nu);
        cost += costOf(nu);
        return nudgedSteps;
      };

      // PREMATURE text-only stop: the model narrated ("now let's copy this…")
      // instead of calling a tool, which ends the SDK loop even with budget
      // remaining — observed live losing a 62-minute research session whose
      // deliverable needed two more tool calls. Unlike the no-tools forced
      // turn below, resuming the REAL tool loop can still finish that work:
      // continue the session ONCE with the remaining budget and a nudge to
      // either keep working or call final_answer. A second tool-less stop
      // falls through to the forced turn / last-text fallback as before.
      if (classifyFinalAnswerStop(answer !== undefined, stepsUsed, cfg.maxSteps) === "nudge") {
        console.warn(
          `[agent] Loop ended tool-lessly at ${stepsUsed}/${cfg.maxSteps} steps without final_answer; nudging the loop once.`,
        );
        try {
          const nudgedSteps = await continueLoop(
            {
              role: "user",
              content:
                "You stopped by sending a message without any tool call — that ends your run, and you have NOT called final_answer. " +
                "If the task is genuinely complete, verify your deliverables now and call final_answer. Otherwise continue the work " +
                "with tool calls. Do not stop again without calling final_answer.\n\n" +
                contract,
            },
            cfg.maxSteps - stepsUsed,
          );
          answer = finalAnswerOf(nudgedSteps);
        } catch (e) {
          giveUp("nudge continuation", e);
        }
      }

      // The loop ended (budget exhausted, or the nudge also stopped tool-lessly)
      // WITHOUT calling final_answer, so we'd otherwise return a stray reasoning
      // sentence and lose the whole (expensive) exploration. Salvage it: force
      // ONE answer turn that must emit the final answer now, continuing the
      // full session. The request is the loop's own PREFIX — `system`, the
      // same `tools` (their `execute` removed, so a call the model makes
      // anyway runs nothing) and `providerOptions` — then the conversation
      // and the forced prompt, which tells the model not to call tools. Under
      // Anthropic's preserved thinking (Fable 5.1 / Opus 5.5) a replayed
      // thinking block is bound to system + tools + the messages before it,
      // so a request that dropped either was a 400 on an enforced account —
      // and a whole-cache miss everywhere, the tools heading the cached
      // prefix. Schema mode still asks for the object through the SDK's
      // output grammar: a single answer turn is what the grammar is for; it
      // is over a tool LOOP that it fails (see the header). Beside tools the
      // provider sends it as `output_config.format` (Opus 4.1 and every model
      // since) — a request field outside system / tools / messages, so not
      // part of the bound prefix; on Sonnet 4 / Opus 4 the SDK's fallback
      // appends a `json` tool and forces it, which changes the tool set and
      // misses the cache as the no-tools request always did — those models
      // have no preserved thinking to break.
      if (answer === undefined) {
        console.warn("[agent] No final_answer tool call; forcing a final-answer turn.");
        try {
          // Streamed for the same severed-connection reason as the main loop —
          // this single turn emits the ENTIRE final answer.
          const forcedPrompt = {
            role: "user" as const,
            content: `You have used your entire exploration budget — do NOT call any tools. Using everything you learned above, produce the final ${useSchema ? "structured " : ""}answer NOW.\n\n${contract}`,
          };
          const forced = streamText({
            model,
            system,
            tools: stripExecute(tools),
            ...(providerOptions ? { providerOptions } : {}),
            ...(useSchema ? { output: Output.object({ schema: jsonSchema(cfg.schema) }) } : {}),
            // The conversation as the model saw it — the thread, this turn's
            // task, what was generated — then the forced prompt: the nudge's
            // shape. (It used to drop `head` on a run with no thread, so the
            // request began at the first assistant turn: an edited prefix.)
            messages: [...head, ...(messages as any[]), forcedPrompt],
          } as any);
          await drain(forced);
          const fu = usageFromSteps(await forced.steps);
          usage = addUsage(usage, fu);
          cost += costOf(fu);
          if (((await forced.toolCalls) as unknown[]).length) {
            // A tool call despite the instruction: it ran nothing and answers
            // nothing, and it is not recorded — a call without its result in
            // the session store would fail the thread's next request.
            console.warn("[agent] the forced final-answer turn called a tool instead of answering; nothing to salvage.");
          } else {
            // The recorded session keeps this turn too.
            messages.push(forcedPrompt, ...((((await forced.response) as any)?.messages ?? []) as any[]));
            const got: unknown = useSchema ? await (forced as any).output : ((await forced.text) ?? "").trim();
            if (got !== undefined && got !== "") answer = got;
          }
        } catch (e) {
          giveUp("forced final-answer turn", e);
        }
      }

      if (useSchema) {
        if (answer === undefined) {
          throw new Error(
            `agent: no structured answer after ${stepsUsed} step(s): the model never called final_answer, and the forced turn produced none`,
          );
        }
        // DEGENERATE answer: final_answer was called with required strings
        // that are empty or filler — a model that bailed early (observed live
        // in a hill-climb: 3 of 8 authoring generations answered `summary: ""`
        // at 5-8 of 200 steps, one echoing a version it never published).
        // Same remedy as the tool-less stop: resume the real loop once and
        // demand a complete answer. A second degenerate answer is returned
        // as-is — the caller's own fallbacks take it from there.
        const bad = degenerateSchemaFields(cfg.schema, answer);
        if (bad.length && stepsUsed < cfg.maxSteps) {
          console.warn(
            `[agent] Structured answer left required field(s) empty/filler (${bad.join(", ")}) at ${stepsUsed}/${cfg.maxSteps} steps; nudging the loop once.`,
          );
          try {
            const nudgedSteps = await continueLoop(
              {
                role: "user",
                content:
                  "Your final_answer call ended your run, but it left " +
                  `required field(s) empty or filler: ${bad.join(", ")}. That answer is what the harness harvests — ` +
                  "an empty field there wastes the whole run. If work remains (something you still had to publish, " +
                  "create, or verify), continue it with tool calls now. Then call final_answer again with EVERY required " +
                  "field filled with real values: never a placeholder, never an empty string.",
              },
              cfg.maxSteps - stepsUsed,
            );
            // The continuation may have done real work (a publish) before
            // answering, so its object is the fresher one — keep it unless it
            // is WORSE than what we already had (or absent).
            const nudgedObject = finalAnswerOf(nudgedSteps);
            const stillBad = nudgedObject === undefined ? bad : degenerateSchemaFields(cfg.schema, nudgedObject);
            if (nudgedObject !== undefined && stillBad.length <= bad.length) answer = nudgedObject;
            if (stillBad.length) {
              console.warn(`[agent] nudged structured answer still has empty/filler field(s): ${stillBad.join(", ")}`);
            }
          } catch (e) {
            giveUp("schema nudge continuation", e);
          }
        }
        console.log(`[agent] completed in ${Date.now() - startTime}ms (${stepsUsed} steps, structured)`);
        return await finish({ result: JSON.stringify(answer), object: answer, steps: stepsUsed, usage, cost });
      }

      let final = typeof answer === "string" ? answer : answer === undefined ? "" : JSON.stringify(answer);
      if (!final && lastText) {
        final = `${lastText}\n\n(Note: model did not invoke final_answer; using last reasoning text.)`;
      }
      console.log(`[agent] completed in ${Date.now() - startTime}ms (${stepsUsed} steps)`);
      return await finish({ result: final, steps: stepsUsed, usage, cost });
    } finally {
      session?.release();
    }
  },
});
