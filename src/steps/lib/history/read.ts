import { posix } from "node:path";
import { z } from "zod";
import type { StrutCapabilities } from "../../../capabilities.js";
import { parseConceptFile } from "../../../concept-seed.js";
import { defineStep, type StepContext } from "../../../core.js";
import { boundsOf, graphFor, readsNamespace } from "../../../graph/scope.js";
import { HISTORY_BRANCH, type HistoryCapability } from "../../../history.js";
import { parseTypeFile } from "../../../packages/graph-types.js";

/**
 * Read the HISTORY (plans/concept-history.md §4; src/history.ts): the
 * workspace as a package directory in git, one commit each time strut heard
 * a write. Four actions, git's own shapes:
 *
 *   log   { path?, run?, from?, to?, limit? }  commits, newest first
 *   show  { path, at }                        a file (or a folder's listing) then
 *   diff  { from, to, path?, patch? }         every path that differs
 *   sync  {}                                  a snapshot now, cause `sync`
 *
 * Wherever a commit is asked for, a time is too: the last commit at or
 * before it. Before reading, what the caller's run wrote is flushed and
 * committed (read-your-writes). Held to the caller's reader list
 * (`graphReaders`, src/graph/scope.ts): a namespace it cannot read — a
 * `namespaces/<ns>/` folder, or `concepts/` for the backend's own — is in
 * none of its answers. With no history here, a plain answer saying so.
 * A page and a type come back `parsed` as the package reader reads them;
 * what a change MEANS (a page moved, renamed) is a view's to say.
 */
const commitOrTime = z
  .string()
  .min(1)
  .describe("A commit id, or a time (ISO 8601, or epoch milliseconds): the last commit at or before it.");

export default defineStep({
  type: "history/read",
  effect: "read",
  description:
    "Read this strut server's HISTORY: every workflow, step, app, Concept page and graph type it held, as a package directory in git, one commit per write it heard (each commit names its cause — `run <id>`, `proposal <id>`, `publish <name> <version>`, `install <package>@<digest>`, `boot`, `sync` — and carries a `Run:` trailer per run that wrote). " +
    "Paths: `workflows/<name>.yaml`, `steps/<name>.ts`, `apps/<name>/…`, `concepts/<key>.md` (a Concept page: front matter name, attributes, parents; the body its docs), `namespaces/<ns>/concepts/<key>.md`, `graph/<Type>.yaml`, `strut.yaml`. " +
    "Actions: `log` { path?, run?, from?, to?, limit? } → commits newest first, each { id, time, author, subject, runs, changes: [{ path, status: added|modified|deleted|renamed, from? }] } (`run`: what that run changed; `from`/`to`: who changed things between two moments; `path` follows a file through renames). " +
    "`show` { path, at } → the file at that commit: { text, parsed? } (a page's or a type's fields), or a folder's entries. " +
    "`diff` { from, to, path?, patch? } → each path that differs with its status and `before` / `after` as `show` gives them (`patch: true` adds the unified diff). " +
    "`sync` → a snapshot now. Wherever a commit is asked for, a time works too (ISO 8601 or epoch ms): the last commit at or before it — a run's start time gives the tree it read. Writes nothing in the graph.",
  input: z.object({
    action: z.enum(["log", "show", "diff", "sync"]).describe("log, show, diff, or sync."),
    path: z.string().optional().describe("A file or a folder in the package layout (show: required; log, diff: optional)."),
    run: z.string().optional().describe("log: only the commits carrying this run (`Run:` trailer)."),
    from: commitOrTime.optional().describe("log: after this commit or time; diff: the older side (required)."),
    to: commitOrTime.optional().describe("log: up to this commit or time (default: now); diff: the newer side (required)."),
    at: commitOrTime.optional().describe("show: the commit or time to read the file at (required)."),
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
    if (cfg.action === "log") return log(git, cfg, visible);
    if (cfg.action === "show") {
      if (cfg.path === undefined) throw new Error("history/read show: `path` is required");
      if (!cfg.at) throw new Error("history/read show: `at` (a commit or a time) is required");
      const at = await commitOf(git, cfg.at);
      if (!at) throw new Error(`history/read: no commit at or before ${cfg.at}`);
      const path = cleanPath(cfg.path);
      const read = visible(path) ? await readAt(git, at.id, path, visible) : null;
      if (!read) throw new Error(`history/read: no ${path || "tree"} at ${at.id.slice(0, 12)}`);
      return { path, at: at.id, time: at.time, ...read };
    }
    if (!cfg.from || !cfg.to) throw new Error("history/read diff: `from` and `to` (commits or times) are required");
    return diff(git, cfg, visible);
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

/** A commit id or a time → the commit then: a time means the last commit
 *  at or before it. Null when there is none (before the first). */
async function commitOf(git: Git, at: string): Promise<{ id: string; time: string } | null> {
  const branch = `refs/heads/${HISTORY_BRANCH}`;
  const describe = async (id: string) => ({ id, time: (await git(["log", "-1", "--format=%cI", id])).trim() });
  const tryRev = async (rev: string) => {
    try {
      return (await git(["rev-parse", "--verify", "-q", `${rev}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  };
  if (/^[0-9a-f]{7,40}$/i.test(at)) {
    const id = await tryRev(at);
    if (id) return describe(id);
  }
  if (at === HISTORY_BRANCH || at === "HEAD") {
    const id = await tryRev(branch);
    return id ? describe(id) : null;
  }
  const ms = /^\d+$/.test(at) ? Number(at) : Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`history/read: ${at} is neither a commit nor a time`);
  if (!(await tryRev(branch))) return null;
  const id = (await git(["rev-list", "-1", `--before=@${Math.floor(ms / 1000)}`, branch])).trim();
  return id ? describe(id) : null;
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

async function log(git: Git, cfg: { path?: string; run?: string; from?: string; to?: string; limit: number }, visible: Visible) {
  const branch = `refs/heads/${HISTORY_BRANCH}`;
  const path = cfg.path !== undefined ? cleanPath(cfg.path) : undefined;
  if (path !== undefined && path && !visible(path)) return { commits: [] };
  const to = cfg.to ? await commitOf(git, cfg.to) : await commitOf(git, HISTORY_BRANCH);
  if (!to) return { commits: [] };
  const from = cfg.from ? await commitOf(git, cfg.from) : null;
  const range = from ? `${from.id}..${to.id}` : to.id;
  let follow = false;
  if (path) {
    let kind = "";
    try {
      kind = (await git(["cat-file", "-t", `${branch}:${path}`])).trim();
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

async function diff(git: Git, cfg: { from?: string; to?: string; path?: string; patch: boolean; limit: number }, visible: Visible) {
  const from = await commitOf(git, cfg.from!);
  const to = await commitOf(git, cfg.to!);
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

/** git's empty tree, which every repository has without holding it. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const strip = ({ kind: _kind, ...rest }: Record<string, unknown>) => rest;
