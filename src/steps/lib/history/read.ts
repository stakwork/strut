import { posix } from "node:path";
import { z } from "zod";
import type { StrutCapabilities } from "../../../capabilities.js";
import { parseConceptFile } from "../../../concept-seed.js";
import { defineStep, type StepContext } from "../../../core.js";
import { BRANCH_NAME } from "../../../branches.js";
import { boundsOf, graphFor, readsNamespace } from "../../../graph/scope.js";
import { DROPPED_REFS, EMPTY_TREE, HISTORY_BRANCH, type HistoryCapability } from "../../../history.js";
import { parseTypeFile } from "../../../packages/graph-types.js";

/**
 * Read the HISTORY (plans/concept-history.md §4; src/history.ts): the
 * workspace as a package directory in git, one commit each time strut heard
 * a write. Five actions, git's own shapes:
 *
 *   log      { path?, run?, from?, to?, branch?, limit? }  commits, newest first
 *   show     { path, at, branch? }                       a file (or a folder's listing) then
 *   diff     { from, to, path?, patch?, branch? }        every path that differs
 *   branches {}                                          main and each Concept branch: tip, fork point
 *   sync     {}                                          a snapshot now, cause `sync`
 *
 * Wherever a commit is asked for, a time is too: the last commit at or
 * before it, on `branch` (main by default) — and a branch's name, its last
 * commit. A Concept branch (src/branches.ts, plans/concept-evals.md item c)
 * is a git branch of its name: `diff { from: "main", to: "<branch>", path:
 * "concepts" }` is the pages the two hold apart, `log { from: "main", to:
 * "<branch>" }` the commits made on the branch, and `branches` gives each
 * one's `base`, the commit it forked from main at. Before reading, what the
 * caller's run wrote is flushed and committed (read-your-writes). Held to the caller's reader list
 * (`graphReaders`, src/graph/scope.ts): a namespace it cannot read — a
 * `namespaces/<ns>/` folder, or `concepts/` for the backend's own — is in
 * none of its answers. With no history here, a plain answer saying so.
 * A page and a type come back `parsed` as the package reader reads them;
 * what a change MEANS (a page moved, renamed) is a view's to say.
 */
const commitOrTime = z
  .string()
  .min(1)
  .describe("A commit id, a branch (`main`, or a Concept branch's name: its last commit), or a time (ISO 8601, or epoch milliseconds): the last commit at or before it on `branch`.");

export default defineStep({
  type: "history/read",
  effect: "read",
  description:
    "Read this strut server's HISTORY: every workflow, step, app, Concept page and graph type it held, as a package directory in git, one commit per write it heard (each commit names its cause — `run <id>`, `proposal <id>`, `publish <name> <version>`, `install <package>@<digest>`, `boot`, `sync` — and carries a `Run:` trailer per run that wrote). " +
    "Paths: `workflows/<name>.yaml`, `steps/<name>.ts`, `apps/<name>/…`, `concepts/<key>.md` (a Concept page: front matter name, attributes, parents; the body its docs), `namespaces/<ns>/concepts/<key>.md`, `graph/<Type>.yaml`, `strut.yaml`. " +
    "Actions: `log` { path?, run?, from?, to?, limit? } → commits newest first, each { id, time, author, subject, runs, changes: [{ path, status: added|modified|deleted|renamed, from? }] } (`run`: what that run changed; `from`/`to`: who changed things between two moments; `path` follows a file through renames). " +
    "`show` { path, at } → the file at that commit: { text, parsed? } (a page's or a type's fields), or a folder's entries. " +
    "`diff` { from, to, path?, patch? } → each path that differs with its status and `before` / `after` as `show` gives them (`patch: true` adds the unified diff). " +
    "`sync` → a snapshot now. Wherever a commit is asked for, a time works too (ISO 8601 or epoch ms): the last commit at or before it — a run's start time gives the tree it read. " +
    "Each Concept branch is a git branch of its name, holding main's tree with `concepts/` its own pages: a branch's name works wherever a commit does (its last commit), and `branch` says which branch a time is read on (main by default). `diff { from: \"main\", to: \"<branch>\", path: \"concepts\" }` → the pages the two hold apart; `log { from: \"main\", to: \"<branch>\" }` → the commits made on the branch; " +
    "`branches` → { branches: [{ name, head, time, base? }], dropped: [{ name, ref, head, time, base? }] }: main and each Concept branch, `base` the commit it forked from main at, and the git branches of dropped ones, kept. Writes nothing in the graph.",
  input: z.object({
    action: z.enum(["log", "show", "diff", "branches", "sync"]).describe("log, show, diff, branches, or sync."),
    path: z.string().optional().describe("A file or a folder in the package layout (show: required; log, diff: optional)."),
    run: z.string().optional().describe("log: only the commits carrying this run (`Run:` trailer)."),
    from: commitOrTime.optional().describe("log: after this commit, branch or time; diff: the older side (required)."),
    to: commitOrTime.optional().describe("log: up to this commit, branch or time (default: `branch` now); diff: the newer side (required)."),
    at: commitOrTime.optional().describe("show: the commit, branch or time to read the file at (required)."),
    branch: z.string().optional().describe("The branch a time is read on, and log's default `to`: `main` (the default) or a Concept branch's name."),
    limit: z.number().int().min(1).max(500).default(50).describe("log: the most commits; diff: the most paths."),
    patch: z.boolean().default(false).describe("diff: add each path's unified diff."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const history = ctx.services?.history;
    if (!history) {
      return {
        history: false,
        message:
          "There is no history on this strut server: it is off (STRUT_HISTORY=0), or the server has no graph, or no `git` to keep it with. Nothing is recorded, so there is nothing to read.",
      };
    }
    if (cfg.action === "sync") {
      const r = await history.sync(ctx.actor);
      return r ? { commit: r.commit ?? null, changed: r.changed, files: r.files, ms: r.ms } : { commit: null, changed: false };
    }
    await history.settle();
    const visible = visibility(ctx);
    const git = history.git.bind(history);
    if (cfg.action === "branches") return branches(git, visible);
    const on = await branchRef(git, cfg.branch, visible);
    if (cfg.action === "log") return log(git, cfg, visible, on);
    if (cfg.action === "show") {
      if (cfg.path === undefined) throw new Error("history/read show: `path` is required");
      if (!cfg.at) throw new Error("history/read show: `at` (a commit or a time) is required");
      const at = await commitOf(git, cfg.at, on);
      if (!at) throw new Error(`history/read: no commit at or before ${cfg.at}`);
      const path = cleanPath(cfg.path);
      const read = visible(path) ? await readAt(git, at.id, path, visible) : null;
      if (!read) throw new Error(`history/read: no ${path || "tree"} at ${at.id.slice(0, 12)}`);
      return { path, at: at.id, time: at.time, ...read };
    }
    if (!cfg.from || !cfg.to) throw new Error("history/read diff: `from` and `to` (commits or times) are required");
    return diff(git, cfg, visible, on);
  },
});

type Git = HistoryCapability["git"];
type Visible = (path: string) => boolean;

/** What the caller may see: every path, unless its reader list leaves a
 *  namespace out. */
function visibility(ctx: StepContext<StrutCapabilities>): Visible {
  const wired = ctx.services?.graph;
  if (!wired) return () => true;
  const g = graphFor(wired, ctx);
  const list = boundsOf(g)?.list;
  if (!list) return () => true;
  const own = g.namespace;
  return (path) => {
    if (path === "concepts" || path.startsWith("concepts/")) return readsNamespace(list, own, own);
    const m = /^namespaces\/([^/]+)/.exec(path);
    return m ? readsNamespace(list, m[1]!, own) : true;
  };
}

/** A path as the layout names it: `/`-separated, relative, no `..`. */
function cleanPath(path: string): string {
  const p = posix.normalize(path.replace(/\\/g, "/")).replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (p === "." || p === "") return "";
  if (p.startsWith("../") || p === "..") throw new Error(`history/read: ${path} is not a path in the history`);
  return p;
}

const MAIN_REF = `refs/heads/${HISTORY_BRANCH}`;

const tryRev = async (git: Git, rev: string) => {
  try {
    return (await git(["rev-parse", "--verify", "-q", `${rev}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
};

/** A Concept branch's git branch, by name, when the history holds it. */
async function branchTip(git: Git, name: string): Promise<string | null> {
  return BRANCH_NAME.test(name) ? tryRev(git, `refs/heads/${name}`) : null;
}

/** The ref `branch` names, which a time is read on: main's by default. A
 *  Concept branch is a copy of the graph's own pages: a caller who cannot
 *  read those cannot read it. */
async function branchRef(git: Git, branch: string | undefined, visible: Visible): Promise<string> {
  if (branch === undefined || branch === HISTORY_BRANCH) return MAIN_REF;
  if (!visible("concepts") || !(await branchTip(git, branch))) throw new Error(`history/read: no branch "${branch}" in the history`);
  return `refs/heads/${branch}`;
}

/** A commit id, a branch or a time → the commit then: a branch means its
 *  last commit (a Concept branch's name before a commit id it also reads
 *  as), a time the last commit at or before it on `on`. Null when there is
 *  none (before the first). */
async function commitOf(git: Git, at: string, on: string = MAIN_REF): Promise<{ id: string; time: string } | null> {
  const describe = async (id: string) => ({ id, time: (await git(["log", "-1", "--format=%cI", id])).trim() });
  if (at === HISTORY_BRANCH || at === "HEAD") {
    const id = await tryRev(git, MAIN_REF);
    return id ? describe(id) : null;
  }
  const tip = await branchTip(git, at);
  if (tip) return describe(tip);
  if (/^[0-9a-f]{7,40}$/i.test(at)) {
    const id = await tryRev(git, at);
    if (id) return describe(id);
  }
  const ms = /^\d+$/.test(at) ? Number(at) : Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`history/read: ${at} is neither a commit, a branch nor a time`);
  if (!(await tryRev(git, on))) return null;
  const id = (await git(["rev-list", "-1", `--before=@${Math.floor(ms / 1000)}`, on])).trim();
  return id ? describe(id) : null;
}

/** Where `head` forked from main: their last common commit. */
async function baseOf(git: Git, head: string): Promise<string | undefined> {
  try {
    return (await git(["merge-base", MAIN_REF, head])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Main and each Concept branch's git branch: its last commit, when, and
 *  the commit it forked from main at; and each dropped one's, kept. A
 *  caller who cannot read the graph's own pages sees main alone. */
async function branches(git: Git, visible: Visible) {
  const rows = (await git(["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)", "refs/heads", DROPPED_REFS.replace(/\/$/, "")]))
    .split("\n")
    .filter(Boolean)
    .map((r) => {
      const [ref, head, time] = r.split("\x1f");
      return { ref: ref!, head: head!, time: time! };
    });
  const live: Array<{ name: string; head: string; time: string; base?: string }> = [];
  const dropped: Array<{ name: string; ref: string; head: string; time: string; base?: string }> = [];
  for (const r of rows) {
    if (r.ref === MAIN_REF) {
      live.unshift({ name: HISTORY_BRANCH, head: r.head, time: r.time });
      continue;
    }
    if (!visible("concepts")) continue;
    const base = await baseOf(git, r.head);
    if (r.ref.startsWith("refs/heads/")) live.push({ name: r.ref.slice("refs/heads/".length), head: r.head, time: r.time, ...(base ? { base } : {}) });
    else dropped.push({ name: r.ref.slice(DROPPED_REFS.length).replace(/\/[^/]*$/, ""), ref: r.ref, head: r.head, time: r.time, ...(base ? { base } : {}) });
  }
  return { branches: live, dropped };
}

/** git's statuses, as the layout's. */
const STATUS: Record<string, "added" | "modified" | "deleted" | "renamed"> = { A: "added", M: "modified", T: "modified", D: "deleted", R: "renamed", C: "added" };

interface Change {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  from?: string;
}

/** `--name-status` lines → changes. */
function changes(lines: string[]): Change[] {
  const out: Change[] = [];
  for (const line of lines) {
    const [code, a, b] = line.split("\t");
    if (!code || !a) continue;
    const status = STATUS[code[0]!];
    if (!status) continue;
    if ((code[0] === "R" || code[0] === "C") && b) out.push({ path: b, status, ...(code[0] === "R" ? { from: a } : {}) });
    else out.push({ path: a, status });
  }
  return out;
}

async function log(git: Git, cfg: { path?: string; run?: string; from?: string; to?: string; limit: number }, visible: Visible, on: string) {
  const path = cfg.path !== undefined ? cleanPath(cfg.path) : undefined;
  if (path !== undefined && path && !visible(path)) return { commits: [] };
  const to = cfg.to ? await commitOf(git, cfg.to, on) : await commitOf(git, on.slice("refs/heads/".length), on);
  if (!to) return { commits: [] };
  const from = cfg.from ? await commitOf(git, cfg.from, on) : null;
  const range = from ? `${from.id}..${to.id}` : to.id;
  let follow = false;
  if (path) {
    let kind = "";
    try {
      kind = (await git(["cat-file", "-t", `${to.id}:${path}`])).trim();
    } catch {
      // gone now: a file, if its last segment reads as one
      kind = /\.[^/]+$/.test(path) ? "blob" : "tree";
    }
    follow = kind === "blob";
  }
  const args = [
    "log",
    "--format=%x1e%H%x1f%cI%x1f%an%x1f%s%x1f%(trailers:key=Run,valueonly,separator=%x2C)",
    "--name-status",
    "-M",
    ...(follow ? ["--follow"] : []),
    ...(cfg.run ? ["--fixed-strings", `--grep=Run: ${cfg.run}`] : []),
    // Over-read so commits the reader cannot see, or another run's, still leave `limit`.
    `-n`,
    String(cfg.run || path === undefined ? (cfg.limit + 1) * 4 : cfg.limit + 1),
    range,
    ...(path ? ["--", path] : []),
  ];
  const out: Array<{ id: string; time: string; author: string; subject: string; runs: string[]; changes: Change[] }> = [];
  for (const chunk of (await git(args)).split("\x1e")) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split("\n");
    const [id, time, author, subject, runs] = head!.split("\x1f");
    if (!id) continue;
    const runList = (runs ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    if (cfg.run && !runList.includes(cfg.run)) continue;
    const all = changes(rest.filter((l) => l.trim()));
    const seen = all.filter((c) => visible(c.path) && (!c.from || visible(c.from)));
    if (all.length && !seen.length) continue; // a commit of what the caller cannot read
    out.push({ id, time: time!, author: author!, subject: subject!, runs: runList, changes: seen });
  }
  return { commits: out.slice(0, cfg.limit), ...(out.length > cfg.limit ? { more: true } : {}) };
}

/** A file at a commit (`text`, `parsed` where the package reader parses
 *  it), or a folder's entries; null when the path is not there. */
async function readAt(git: Git, id: string, path: string, visible: Visible): Promise<Record<string, unknown> | null> {
  let kind: string;
  try {
    kind = path ? (await git(["cat-file", "-t", `${id}:${path}`])).trim() : "tree";
  } catch {
    return null;
  }
  if (kind === "tree") {
    const rows = (await git(["ls-tree", path ? `${id}:${path}` : id])).split("\n").filter(Boolean);
    const entries = rows
      .map((r) => {
        const [meta, name] = r.split("\t");
        return { name: name!, kind: meta!.split(" ")[1] === "tree" ? ("folder" as const) : ("file" as const) };
      })
      .filter((e) => visible(path ? `${path}/${e.name}` : e.name));
    // `namespaces/` itself only when the caller may read one in it.
    const ns = entries.findIndex((e) => !path && e.name === "namespaces");
    if (ns >= 0) {
      const inside = (await git(["ls-tree", "--name-only", `${id}:namespaces`])).split("\n").filter(Boolean);
      if (!inside.some((n) => visible(`namespaces/${n}`))) entries.splice(ns, 1);
    }
    return { kind: "folder", entries };
  }
  if (kind !== "blob") return null;
  return { kind: "file", ...fileOf(path, await git(["show", `${id}:${path}`])) };
}

/** A file's text and, where the package reader parses it, `parsed`. */
function fileOf(path: string, text: string): Record<string, unknown> {
  if (text.slice(0, 8000).includes("\u0000")) return { binary: true };
  const page = /^(?:namespaces\/[^/]+\/)?concepts\/([^/]+\.md)$/.exec(path);
  const type = /^graph\/([A-Za-z][A-Za-z0-9_]*)\.yaml$/.exec(path);
  try {
    if (page) {
      const c = parseConceptFile(page[1]!, text, "");
      return { text, parsed: { name: c.name, attributes: c.attributes, parents: c.parents, ...(c.docs !== undefined ? { docs: c.docs } : {}) } };
    }
    if (type) {
      const t = parseTypeFile(type[1]!, path, text);
      return { text, parsed: { ...t.input, edges: t.edges } };
    }
  } catch (err) {
    return { text, parseError: err instanceof Error ? err.message : String(err) };
  }
  return { text };
}

async function diff(git: Git, cfg: { from?: string; to?: string; path?: string; patch: boolean; limit: number }, visible: Visible, on: string) {
  const from = await commitOf(git, cfg.from!, on);
  const to = await commitOf(git, cfg.to!, on);
  if (!to) throw new Error(`history/read: no commit at or before ${cfg.to}`);
  // Before the first commit, the tree was empty.
  const fromRev = from?.id ?? EMPTY_TREE;
  const path = cfg.path !== undefined ? cleanPath(cfg.path) : "";
  if (path && !visible(path)) return { from: from?.id ?? null, to: to.id, entries: [] };
  const all = changes(
    (await git(["diff", "--name-status", "-M", fromRev, to.id, ...(path ? ["--", path] : [])])).split("\n").filter(Boolean),
  ).filter((c) => visible(c.path) && (!c.from || visible(c.from)));
  const entries = [];
  for (const c of all.slice(0, cfg.limit)) {
    const before = c.status === "added" ? undefined : await readAt(git, fromRev, c.from ?? c.path, visible);
    const after = c.status === "deleted" ? undefined : await readAt(git, to.id, c.path, visible);
    const patch = cfg.patch ? await git(["diff", "-M", fromRev, to.id, "--", ...(c.from ? [c.from] : []), c.path]) : undefined;
    entries.push({ ...c, ...(before ? { before: strip(before) } : {}), ...(after ? { after: strip(after) } : {}), ...(patch !== undefined ? { patch } : {}) });
  }
  return { from: from?.id ?? null, to: to.id, entries, ...(all.length > cfg.limit ? { more: true } : {}) };
}

const strip = ({ kind: _kind, ...rest }: Record<string, unknown>) => rest;
