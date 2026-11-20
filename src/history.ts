/**
 * The HISTORY (plans/concept-history.md): what this strut held, when, and
 * which run changed it — the whole workspace written as a package directory
 * (`packageFiles(…, EVERYTHING)`, src/packages/build.ts) and committed to a
 * bare git repository under the data directory each time strut hears a
 * write. The graph stays the source; git only records, and nothing reads
 * it to serve the graph. `history/read` (src/steps/lib/history/read.ts) is
 * the door.
 *
 *   <dataDir>/history.git         the repository, bare, branch `main` (and
 *                                 one per Concept branch, below)
 *   <dataDir>/history.git/work/   the work tree a snapshot is written into
 *                                 (inside the repository, so it moves and is
 *                                 backed up with it; rebuilt by any snapshot)
 *
 * TOUCHES (§3): a run's graph view tells the history when it flushes a
 * write a snapshot records — a Concept, a `PARENT_OF` edge, a type or an
 * edge rule, a step's claim (`historyRecords`, src/graph-writes.ts; a write
 * of unknown type counts) — never a flush of instances alone, and
 * the workspace store is wrapped once (`watch`) so a publish, a change of
 * the active version, a delete or an app release touches it after it
 * returns. An install or an uninstall is HELD (`hold`): what it publishes
 * is one commit under its own cause. Boot touches once, after the seeds
 * (`start`); `history/read { action: sync }` touches on demand.
 *
 * A touch becomes a SNAPSHOT on one in-process queue: a second after the
 * last touch (five at most after the first), every file is written into the
 * work tree — only the files whose bytes changed — and when any did, the
 * index is committed with `commit-tree`: the author is the actor who wrote
 * (`strut` for boot and sync, `HISTORY_EMAIL` for all), the first line the
 * first cause, the other causes below it, and one `Run:` trailer per run
 * whose flush touched since the last commit. A snapshot that changes nothing
 * commits nothing. One that fails is logged and never fails anything; the
 * next catches up, since each is whole.
 *
 * READ-YOUR-WRITES: `settle` flushes every view with writes waiting and runs
 * the queue now, so a step reads its own run's writes.
 *
 * CONCEPT BRANCHES (src/branches.ts, plans/concept-evals.md item c; ruling 2:
 * a git branch plus a graph namespace): each is a git branch of the same
 * name in this repository. Made (`branched`), it starts at main's commit
 * then — main is snapshotted first, so the fork point is the live tree —
 * and commits its own pages when they differ (none for `from: "empty"`). A
 * write a run on it makes (or a proposal applied on it) touches it, never
 * main (`HistoryTouch.branch`); a type or a claim a run on it writes is the
 * live graph's and touches main (src/graph-writes.ts). A branch's commit is
 * its last tree with `concepts/` swapped for the branch's pages (`mktree`
 * over the blobs that changed): it never reads the workspace, so it costs one
 * read of the branch's pages, and a branch differs from where it started
 * under `concepts/` alone. Dropped (`dropBranch`), what it waits to commit
 * is committed, and the git branch moves to `refs/dropped/<name>/<time>`:
 * the record of what was tried, the name free again. The only state per
 * branch is its ref; the memo of its tree is read back from it.
 *
 * GIT: run through `runProcess` (src/shell.ts) with the binary found on
 * PATH, no user or system config, no hooks, no signing. On macOS
 * `/usr/bin/git` is a shim that asks to install the Command Line Tools, so
 * `xcode-select -p` is asked first and a boot never raises that dialog
 * (`findGit`). No `git`: no history, said once at boot.
 */
import { createHash } from "node:crypto";
import { access, constants, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { AppsCapability } from "./apps/apps.js";
import type { ClaimsAuthoring } from "./claims-authoring.js";
import { bootEnv } from "./env.js";
import type { GraphBackend } from "./graph/backend.js";
import { BRANCH_NAMESPACE_PREFIX } from "./graph/search.js";
import { conceptFilesOf, EVERYTHING, newWholeMemo, packageFiles, type WholeMemo } from "./packages/build.js";
import { packageCache } from "./packages/cache.js";
import { runProcess, type ProcessResult } from "./shell.js";
import type { WorkspaceStore } from "./workspace.js";

/** The repository, under the data directory. */
export const HISTORY_DIR = "history.git";
/** The work tree, inside the repository. */
export const HISTORY_WORK = "work";
/** Every commit's email: the history is no one's mailbox. */
export const HISTORY_EMAIL = "history@strut.invalid";
/** The author of a commit nobody in particular caused (boot, sync). */
export const HISTORY_ACTOR = "strut";
/** A snapshot this long after the last touch… */
export const HISTORY_DEBOUNCE_MS = 1_000;
/** …and never later than this after the first one waiting. */
export const HISTORY_MAX_DELAY_MS = 5_000;
/** The branch every snapshot of the workspace commits to. */
export const HISTORY_BRANCH = "main";
/** Where a dropped Concept branch's git branch is kept: `<this><name>/<time>`. */
export const DROPPED_REFS = "refs/dropped/";
/** git's empty tree, which every repository has without holding it. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO = "0000000000000000000000000000000000000000";

/** What touched the history: the commit's cause, who, and the run. */
export interface HistoryTouch {
  /** `run <id>`, `proposal <id>`, `publish <name> <version>`,
   *  `install <package>@<digest>`, `boot`, `sync`… */
  cause: string;
  actor?: string;
  /** A run whose writes this is: a `Run:` trailer. */
  run?: string;
  /** The Concept branch it is a write on (src/branches.ts): committed to its
   *  git branch, never main's. */
  branch?: string;
}

export interface SnapshotResult {
  /** The commit made, absent when nothing changed. */
  commit?: string;
  changed: boolean;
  /** Files the snapshot wrote, removed, and holds. */
  written: number;
  removed: number;
  files: number;
  ms: number;
  warnings: string[];
}

/** What `history/read` and the graph view reach, as `ctx.services.history`. */
export interface HistoryCapability {
  /** The repository's path. */
  readonly dir: string;
  /** A view has writes waiting: `settle` flushes it. */
  waiting(flush: () => Promise<void>): void;
  /** Something changed what a snapshot writes; `from`, the view that sent it. */
  touch(t: HistoryTouch, from?: () => Promise<void>): void;
  /** A view sent its writes and none was one the history records
   *  (`historyRecords`, src/graph-writes.ts): nothing of it waits. */
  skipped(from: () => Promise<void>): void;
  /** Flush every view with writes waiting and run the queue now. */
  settle(): Promise<void>;
  /** A snapshot now, cause `sync` (after what is waiting). */
  sync(actor?: string): Promise<SnapshotResult | undefined>;
  /** A read-only git command on the repository: stdout, or a thrown error
   *  with git's own message. */
  git(args: string[]): Promise<string>;
}

export interface History extends HistoryCapability {
  /** The workspace store, every write that changes a snapshot touching. */
  watch(ws: WorkspaceStore): WorkspaceStore;
  /** `fn`, its writes one commit under the cause `touchOf` gives once it
   *  returned (or threw: `undefined`). */
  hold<T>(fn: () => Promise<T>, touchOf: (r: T | undefined) => HistoryTouch): Promise<T>;
  /** Boot is done: the first snapshot, cause `boot`, taken now and
   *  awaited, and every touch from now on. Before it, touches wait. */
  start(): Promise<void>;
  /** Commit what is waiting, then stop. */
  close(): Promise<void>;
  /** A Concept branch was made (its pages copied): its git branch, of the
   *  same name, from main's commit now (main snapshotted first), its pages
   *  committed on it under `t` where they differ. A git branch of that name
   *  already there is put aside first, as a drop keeps one. */
  branched(name: string, t: Omit<HistoryTouch, "branch" | "run">): Promise<void>;
  /** A Concept branch is going (before its pages are removed): what it
   *  waits to commit is committed, and its git branch moved to
   *  `refs/dropped/<name>/<time>`; its touches from now on are dropped.
   *  Where it was kept, or nothing when it has no git branch. */
  dropBranch(name: string): Promise<{ ref: string; commit: string } | undefined>;
}

export interface HistoryDeps {
  dataDir: string;
  /** The workspace as the server built it (never the watched one: a
   *  snapshot reads, it never touches). */
  workspace: WorkspaceStore;
  graph?: GraphBackend;
  /** Read lazily: the claims layer and the apps service come after the history. */
  claims?: () => Pick<ClaimsAuthoring, "reader"> | null | undefined;
  apps?: () => Pick<AppsCapability, "versionDir"> | undefined;
  /** The Concept branches (src/branches.ts), read at boot: each one's git
   *  branch is caught up, and made when it has none. Read lazily: they come
   *  after the history. */
  branches?: () => { list(): Promise<Array<{ name: string }>> } | undefined;
  /** The `git` binary (`findGit`). */
  git: string;
  debounceMs?: number;
  maxDelayMs?: number;
}

// ── git ───────────────────────────────────────────────────────────────────

const exec = async (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    async () => (await stat(path)).isFile(),
    () => false,
  );

/**
 * The `git` this strut can run without side effects, or why there is none:
 * the first on PATH; on macOS `/usr/bin/git` only when the Command Line
 * Tools are there (`xcode-select -p`), since otherwise running it opens
 * the install dialog; and it must answer `--version`.
 */
export async function findGit(env: NodeJS.ProcessEnv = bootEnv()): Promise<{ path: string; version: string } | { missing: string }> {
  const name = process.platform === "win32" ? "git.exe" : "git";
  let found: string | undefined;
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await exec(candidate)) {
      found = candidate;
      break;
    }
  }
  if (!found) return { missing: "git is not on PATH" };
  if (process.platform === "darwin" && found === "/usr/bin/git") {
    const cl = await runProcess({ cmd: "/usr/bin/xcode-select", args: ["-p"], cwd: "/", timeoutMs: 10_000 }).catch(() => null);
    if (!cl || cl.code !== 0) return { missing: "/usr/bin/git needs the Command Line Tools, which are not installed (xcode-select -p) — install them, or git from elsewhere" };
  }
  const v = await runProcess({ cmd: found, args: ["--version"], cwd: "/", timeoutMs: 10_000 }).catch(() => null);
  if (!v || v.code !== 0) return { missing: `${found} --version failed` };
  return { path: found, version: v.stdout.trim() };
}

/** What every git command here runs with: no system or user config, no
 *  hooks, no signing, no prompt, paths unquoted. */
const GIT_FLAGS = [
  "-c", "core.quotepath=false",
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgsign=false",
  "-c", "gc.auto=0",
  "-c", "advice.detachedHead=false",
];

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/** One chain per repository in this process: two struts over one data
 *  directory (a test, a host that builds a second) never run git on it at
 *  once — git's own locks would fail the second. */
const repoChains = new Map<string, Promise<unknown>>();
function onRepo<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = (repoChains.get(dir) ?? Promise.resolve()).then(fn);
  const settled = next.catch(() => undefined);
  repoChains.set(dir, settled);
  void settled.then(() => {
    if (repoChains.get(dir) === settled) repoChains.delete(dir);
  });
  return next;
}

interface RepoState {
  onDisk?: Map<string, string>;
  /** No snapshot staged since this process opened the repository. */
  first: boolean;
  head?: string | null;
  headTree?: string | null;
  commits: number;
  /** Each Concept branch's git branch as last read or committed. */
  branches: Map<string, BranchState>;
}
/** A Concept branch's git branch: the commit it is at (null before its
 *  first, when main had none), its tree, that tree's root entries but
 *  `concepts` (a branch's commit never changes them), and `concepts/`'s
 *  files by name → blob id. */
interface BranchState {
  head: string | null;
  tree: string;
  rest: string[];
  concepts: Map<string, string>;
}
const freshState = (): RepoState => ({ onDisk: undefined, first: true, head: undefined, headTree: undefined, commits: 0, branches: new Map() });
const repoStates = new Map<string, RepoState>();
const repoState = (dir: string): RepoState => {
  let s = repoStates.get(dir);
  if (!s) repoStates.set(dir, (s = freshState()));
  return s;
};

/** The commands `git()` runs for a reader: they read, nothing else. */
const READ_COMMANDS = new Set(["log", "show", "diff", "rev-list", "rev-parse", "ls-tree", "cat-file", "merge-base", "for-each-ref"]);

/** A blob's id, as git names it in a SHA-1 repository (what `init` makes). */
const blobId = (bytes: Buffer): string => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** `ls-tree -z` output → its entries, `<mode> <type> <id>\t<name>` each. */
const treeEntries = (out: string): string[] => out.split("\0").filter(Boolean);
const entryName = (e: string): string => e.slice(e.indexOf("\t") + 1);
const entryId = (e: string): string => e.slice(0, e.indexOf("\t")).split(" ")[2] ?? "";

// ── the history ───────────────────────────────────────────────────────────

/** The history over `deps`, the repository made on first use. */
export function createHistory(deps: HistoryDeps): History {
  const dir = join(deps.dataDir, HISTORY_DIR);
  const work = join(dir, HISTORY_WORK);
  const debounce = deps.debounceMs ?? HISTORY_DEBOUNCE_MS;
  const maxDelay = deps.maxDelayMs ?? HISTORY_MAX_DELAY_MS;
  const cache = packageCache(deps.dataDir);
  const memo: WholeMemo = newWholeMemo();

  const run = async (args: string[], o: { stdin?: string; env?: Record<string, string>; workTree?: boolean } = {}): Promise<ProcessResult> =>
    runProcess({
      cmd: deps.git,
      args: [...GIT_FLAGS, "-c", `safe.directory=${dir}`, ...args],
      cwd: o.workTree ? work : deps.dataDir,
      ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
      env: {
        GIT_DIR: dir,
        ...(o.workTree ? { GIT_WORK_TREE: work } : {}),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        ...o.env,
      },
      timeoutMs: 120_000,
      maxOutputChars: 64 * 1024 * 1024,
    });
  const git = async (args: string[], o: Parameters<typeof run>[1] = {}): Promise<string> => {
    const r = await run(args, o);
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim() || `exit ${r.code ?? r.signal}`}`);
    return r.stdout;
  };

  // What this process knows of the repository, shared by every history
  // over it: the work tree by path → sha1 of its bytes (a file is written
  // only when its bytes change, so git's stat cache stays good; read from
  // disk on the first snapshot), and the commit and tree `main` is at.
  const state = repoState(dir);
  /** The repository, made when it is not there (run on the repo's chain). */
  const ensureRepo = async () => {
    if (!(await stat(join(dir, "HEAD")).catch(() => null))) {
      // A data directory that is gone (a host or a test removed it) is not
      // made again here.
      if (!(await stat(deps.dataDir).catch(() => null))) throw new Error(`the data directory ${deps.dataDir} is gone`);
      Object.assign(state, freshState());
      const r = await runProcess({ cmd: deps.git, args: [...GIT_FLAGS, "init", "--bare", "-q", "--template=", dir], cwd: deps.dataDir, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEVICE } });
      if (r.code !== 0) throw new Error(`git init: ${r.stderr.trim()}`);
      await git(["symbolic-ref", "HEAD", `refs/heads/${HISTORY_BRANCH}`]);
    }
    await mkdir(work, { recursive: true });
  };

  const sum = (b: Buffer) => createHash("sha1").update(b).digest("hex");
  const walk = async (): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const go = async (rel: string): Promise<void> => {
      for (const e of await readdir(rel ? join(work, rel) : work, { withFileTypes: true }).catch(() => [])) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await go(p);
        else if (e.isFile()) out.set(p, sum(await readFile(join(work, p))));
      }
    };
    await go("");
    return out;
  };
  const verify = async (rev: string): Promise<string | null> => (await run(["rev-parse", "-q", "--verify", `${rev}^{commit}`])).stdout.trim() || null;
  const commitTree = async (tree: string, parent: string | null, take: Pending): Promise<string> => {
    const when = `${Math.floor(Date.now() / 1000)} +0000`;
    const author = take.actor || HISTORY_ACTOR;
    return (
      await git(["commit-tree", "--no-gpg-sign", tree, ...(parent ? ["-p", parent] : [])], {
        stdin: message(take),
        env: {
          GIT_AUTHOR_NAME: author,
          GIT_AUTHOR_EMAIL: HISTORY_EMAIL,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_NAME: HISTORY_ACTOR,
          GIT_COMMITTER_EMAIL: HISTORY_EMAIL,
          GIT_COMMITTER_DATE: when,
        },
      })
    ).trim();
  };
  async function snapshot(take: Pending): Promise<SnapshotResult> {
    const started = Date.now();
    await ensureRepo();
    const out = await packageFiles(
      {
        workspace: deps.workspace,
        cache,
        ...(deps.graph ? { graph: deps.graph } : {}),
        claims: deps.claims?.() ?? null,
        ...(deps.apps?.() ? { apps: deps.apps()! } : {}),
        memo,
      },
      EVERYTHING,
    );
    const onDisk = (state.onDisk ??= await walk());
    let written = 0;
    let removed = 0;
    for (const [path, content] of out.files) {
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      const s = sum(bytes);
      if (onDisk.get(path) === s) continue;
      const abs = join(work, ...path.split("/"));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      onDisk.set(path, s);
      written++;
    }
    for (const path of [...onDisk.keys()]) {
      if (out.files.has(path)) continue;
      await rm(join(work, ...path.split("/")), { force: true });
      onDisk.delete(path);
      removed++;
      await pruneEmpty(work, path);
    }
    const result: SnapshotResult = { changed: false, written, removed, files: out.files.size, ms: 0, warnings: out.warnings };
    // Nothing on disk changed and the index was read once since boot: the
    // tree is the one committed.
    if (!written && !removed && !state.first) return { ...result, ms: Date.now() - started };
    state.first = false;
    await git(["add", "-A"], { workTree: true });
    const tree = (await git(["write-tree"])).trim();
    if (state.headTree === undefined) {
      state.head = (await run(["rev-parse", "-q", "--verify", `refs/heads/${HISTORY_BRANCH}`])).stdout.trim() || null;
      state.headTree = state.head ? (await git(["rev-parse", `${state.head}^{tree}`])).trim() : null;
    }
    const head = state.head ?? null;
    if (tree === state.headTree) return { ...result, ms: Date.now() - started };
    const commit = await commitTree(tree, head, take);
    await git(["update-ref", `refs/heads/${HISTORY_BRANCH}`, commit, ...(head ? [head] : [])]);
    state.head = commit;
    state.headTree = tree;
    if (++state.commits % 500 === 0) await run(["gc", "--auto", "--quiet"]).catch(() => undefined);
    return { ...result, commit, changed: true, ms: Date.now() - started };
  }

  // ── Concept branches ──
  /** A branch's git branch as it is, read once; one it lacks is made at
   *  main's commit now (the fork point). */
  const loadBranch = async (name: string): Promise<BranchState> => {
    const ref = `refs/heads/${name}`;
    let head = await verify(ref);
    if (!head) {
      head = await verify(`refs/heads/${HISTORY_BRANCH}`);
      if (head) await git(["update-ref", ref, head, ZERO]);
    }
    if (!head) return { head: null, tree: EMPTY_TREE, rest: [], concepts: new Map() };
    const root = treeEntries(await git(["ls-tree", "-z", head]));
    const at = root.find((e) => entryName(e) === "concepts");
    const concepts = new Map<string, string>();
    if (at) for (const e of treeEntries(await git(["ls-tree", "-z", entryId(at)]))) concepts.set(entryName(e), entryId(e));
    return { head, tree: (await git(["rev-parse", `${head}^{tree}`])).trim(), rest: root.filter((e) => e !== at), concepts };
  };
  /** A Concept branch's snapshot: its last tree, `concepts/` the branch's
   *  pages now. Nothing of the workspace is read: only the blobs of pages
   *  that changed are written. */
  async function branchSnapshot(name: string, take: Pending): Promise<SnapshotResult> {
    const started = Date.now();
    await ensureRepo();
    const b = state.branches.get(name) ?? (await loadBranch(name));
    state.branches.set(name, b);
    const { files, warnings } = await conceptFilesOf(deps.graph!, `${BRANCH_NAMESPACE_PREFIX}${name}`);
    const pages = new Map<string, string>();
    const fresh: Array<{ file: string; bytes: Buffer }> = [];
    const known = new Set(b.concepts.values());
    for (const [path, text] of files) {
      const file = path.slice("concepts/".length);
      const bytes = Buffer.from(text);
      const id = blobId(bytes);
      pages.set(file, id);
      if (!known.has(id)) fresh.push({ file, bytes });
    }
    const result: SnapshotResult = { changed: false, written: 0, removed: 0, files: pages.size, ms: 0, warnings };
    if (pages.size === b.concepts.size && [...pages].every(([f, id]) => b.concepts.get(f) === id)) return { ...result, ms: Date.now() - started };
    if (fresh.length) {
      // Through files, so one `hash-object` writes them all.
      const tmp = await mkdtemp(join(dir, "blobs-"));
      try {
        const paths = await Promise.all(fresh.map(async (f, i) => {
          const at = join(tmp, String(i));
          await writeFile(at, f.bytes);
          return at;
        }));
        const ids = (await git(["hash-object", "-w", "--no-filters", "--stdin-paths"], { stdin: `${paths.join("\n")}\n` })).split("\n").filter(Boolean);
        fresh.forEach((f, i) => ids[i] && pages.set(f.file, ids[i]!));
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    const sub = pages.size ? (await git(["mktree", "-z"], { stdin: [...pages].map(([f, id]) => `100644 blob ${id}\t${f}\0`).join("") })).trim() : null;
    const tree = (await git(["mktree", "-z"], { stdin: [...b.rest, ...(sub ? [`040000 tree ${sub}\tconcepts`] : [])].map((e) => `${e}\0`).join("") })).trim();
    const written = [...pages].filter(([f, id]) => b.concepts.get(f) !== id).length;
    const removed = [...b.concepts.keys()].filter((f) => !pages.has(f)).length;
    if (tree === b.tree) {
      b.concepts = pages;
      return { ...result, ms: Date.now() - started };
    }
    const commit = await commitTree(tree, b.head, take);
    await git(["update-ref", `refs/heads/${name}`, commit, b.head ?? ZERO]);
    Object.assign(b, { head: commit, tree, concepts: pages });
    return { ...result, commit, changed: true, written, removed, ms: Date.now() - started };
  }
  /** Where a dropped branch's git branch is kept: a ref per drop, by time. */
  const keptRef = (name: string) => `${DROPPED_REFS}${name}/${new Date().toISOString().replace(/[-:.]/g, "")}`;
  /** A git branch put aside: kept under `refs/dropped/`, the name free. */
  const putAside = async (name: string): Promise<{ ref: string; commit: string } | undefined> => {
    state.branches.delete(name);
    const ref = `refs/heads/${name}`;
    const head = await verify(ref);
    if (!head) return undefined;
    const kept = keptRef(name);
    await git(["update-ref", kept, head, ZERO]);
    await git(["update-ref", "-d", ref, head]);
    return { ref: kept, commit: head };
  };

  // ── the queue ──
  // One pending snapshot per target: main's (`MAIN`) and each Concept
  // branch's (its name), each with its own debounce; one chain runs them.
  const pending = new Map<string, Pending>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Branches dropped in this process: their touches are dropped too. */
  const gone = new Set<string>();
  /** Main's last snapshot's result. */
  let last: SnapshotResult | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let started = false;
  let closed = false;
  let holds = 0;
  const waitingViews = new Set<() => Promise<void>>();

  const pend = (key: string): Pending => {
    let p = pending.get(key);
    if (!p) pending.set(key, (p = { causes: [], runs: [], firstAt: Date.now() }));
    return p;
  };
  const add = (t: HistoryTouch): string => {
    const key = t.branch ?? MAIN;
    const p = pend(key);
    // Inside a hold, its own cause replaces what it publishes (main's alone).
    const held = key === MAIN && holds > 0;
    if (!held && !p.causes.includes(t.cause)) p.causes.push(t.cause);
    if (!held && !p.actor && t.actor) p.actor = t.actor;
    if (t.run && !p.runs.includes(t.run)) p.runs.push(t.run);
    return key;
  };
  const schedule = (key: string) => {
    const p = pending.get(key);
    if (!p || !started || closed || (key === MAIN && holds > 0)) return;
    clearTimeout(timers.get(key));
    const timer = setTimeout(() => void drain(key), Math.max(0, Math.min(debounce, p.firstAt + maxDelay - Date.now())));
    timer.unref?.();
    timers.set(key, timer);
  };
  /** `fn` on the chain, after any snapshot in flight, on the repository's own chain. */
  const queued = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(() => onRepo(dir, fn));
    chain = p.catch(() => undefined);
    return p;
  };
  /** Run `key`'s pending snapshot now, after any in flight; its result. */
  const drain = (key: string): Promise<SnapshotResult | undefined> => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    return queued(async () => {
      const take = pending.get(key);
      pending.delete(key);
      if (!take || (key !== MAIN && gone.has(key))) return undefined;
      try {
        if (key !== MAIN) return await branchSnapshot(key, take);
        return (last = await snapshot(take));
      } catch (err) {
        // Read back from git next time: the memo may be ahead of the ref.
        if (key !== MAIN) state.branches.delete(key);
        console.warn(`[history] snapshot${key !== MAIN ? ` of branch ${key}` : ""} (${take.causes[0] ?? "sync"}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    });
  };
  /** Every target's pending snapshot, main's first. */
  const drainAll = async () => {
    const keys = [...pending.keys()].sort((a, b) => (a === MAIN ? -1 : b === MAIN ? 1 : 0));
    await Promise.all(keys.map(drain));
  };
  const flushViews = async () => {
    const views = [...waitingViews];
    waitingViews.clear();
    await Promise.all(views.map((f) => f().catch(() => undefined)));
  };

  const history: History = {
    dir,
    waiting(flush) {
      if (!closed) waitingViews.add(flush);
    },
    touch(t, from) {
      if (from) waitingViews.delete(from);
      if (closed || (t.branch !== undefined && gone.has(t.branch))) return;
      schedule(add(t));
    },
    skipped(from) {
      waitingViews.delete(from);
    },
    async settle() {
      await flushViews();
      if (!started) return;
      await drainAll();
    },
    async sync(actor) {
      await flushViews();
      if (closed) return undefined;
      add({ cause: "sync", actor: actor ?? HISTORY_ACTOR });
      if (!started) return undefined;
      // A timer may have taken the touch first: then its snapshot is this one.
      return (await drain(MAIN)) ?? last;
    },
    async git(args) {
      if (!READ_COMMANDS.has(args[0] ?? "") || args.some((a) => a.startsWith("--output"))) throw new Error(`history: git ${args.join(" ")} is not a read`);
      await onRepo(dir, ensureRepo);
      return git(args);
    },
    watch(ws) {
      return watchWorkspace(ws, (t) => {
        // What the workspace wrote may change the installed pins.
        memo.pins = undefined;
        history.touch(t);
      });
    },
    async hold(fn, touchOf) {
      holds++;
      let result: Awaited<ReturnType<typeof fn>> | undefined;
      try {
        result = await fn();
        return result;
      } finally {
        holds--;
        memo.pins = undefined;
        const t = touchOf(result);
        const p = pend(MAIN);
        p.causes = [t.cause, ...p.causes.filter((c) => c !== t.cause)];
        p.actor = t.actor ?? p.actor;
        if (t.run && !p.runs.includes(t.run)) p.runs.push(t.run);
        schedule(MAIN);
      }
    },
    async start() {
      if (started || closed) return;
      started = true;
      // What the seeds published is the boot's.
      pending.set(MAIN, { causes: ["boot"], actor: HISTORY_ACTOR, runs: pending.get(MAIN)?.runs ?? [], firstAt: Date.now() });
      await mkdir(deps.dataDir, { recursive: true }).catch(() => undefined);
      await drain(MAIN);
      // Each Concept branch's git branch caught up (a write it missed), and
      // made where there is none (a branch made with the history off).
      const branches = await deps.branches?.()?.list().catch(() => []) ?? [];
      for (const { name } of branches) {
        const p = pend(name);
        if (!p.causes.length) p.causes.push("boot");
        p.actor ??= HISTORY_ACTOR;
      }
      await drainAll();
    },
    async close() {
      if (closed) return;
      await flushViews();
      if (started) await drainAll();
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await chain;
    },
    async branched(name, t) {
      gone.delete(name);
      await flushViews();
      // The fork point is main's commit of the live tree.
      if (started && !closed) {
        add({ cause: "sync", actor: t.actor ?? HISTORY_ACTOR });
        await drain(MAIN);
      }
      // A git branch of that name is another's, from before: kept aside.
      await queued(async () => {
        await ensureRepo();
        const kept = await putAside(name);
        if (kept) console.log(`[history] branch ${name}: an earlier git branch of that name is kept as ${kept.ref}`);
      }).catch((err: unknown) => console.warn(`[history] branch ${name}: ${err instanceof Error ? err.message : String(err)}`));
      add({ ...t, branch: name });
      if (started && !closed) await drain(name);
    },
    async dropBranch(name) {
      // What its runs wrote is in its record before it goes.
      await flushViews();
      if (started && pending.has(name)) await drain(name);
      gone.add(name);
      pending.delete(name);
      clearTimeout(timers.get(name));
      timers.delete(name);
      return queued(async () => {
        await ensureRepo();
        return putAside(name);
      });
    },
  };
  return history;
}

/** Main's key in the queue; a Concept branch's is its name, never empty. */
const MAIN = "";

interface Pending {
  causes: string[];
  actor?: string;
  runs: string[];
  firstAt: number;
}

/** A commit's message: the first cause, the others below it, then one
 *  `Run:` trailer per run. */
function message(p: Pending): string {
  const lines = [p.causes[0] ?? "sync"];
  if (p.causes.length > 1) lines.push("", ...p.causes.slice(1));
  if (p.runs.length) lines.push("", ...p.runs.map((r) => `Run: ${r}`));
  return `${lines.join("\n")}\n`;
}

async function pruneEmpty(root: string, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  while (parts.length) {
    const d = join(root, ...parts);
    if ((await readdir(d).catch(() => ["?"])).length) return;
    await rm(d, { recursive: true, force: true });
    parts.pop();
  }
}

// ── the workspace, watched ────────────────────────────────────────────────

const actorOf = (o: unknown): string | undefined => {
  const a = (o as { actor?: unknown } | undefined)?.actor;
  return typeof a === "string" && a ? a : undefined;
};

/**
 * The workspace store with every method that changes what a snapshot
 * writes touching the history once it returned: publishes, a change of the
 * active version, deletes, an app's release. Metadata a package does not
 * carry (category, owner, cap, schedules, a pin as a tab) touches nothing.
 * Every other method, and `instanceof`, are the store's own.
 */
function watchWorkspace(ws: WorkspaceStore, touch: (t: HistoryTouch) => void): WorkspaceStore {
  const causes: Record<string, (args: unknown[], res: unknown) => HistoryTouch> = {
    createWorkflow: (a, r) => ({ cause: `publish ${a[0]} ${(r as { version?: string })?.version ?? ""}`.trim(), ...withActor(actorOf(a[5])) }),
    publishWorkflow: (a) => ({ cause: `publish ${a[0]} ${a[1]}`, ...withActor(actorOf(a[6])) }),
    publishWorkflowByContent: (a, r) => ({ cause: `publish ${a[0]} ${(r as { version?: string })?.version ?? ""}`.trim(), ...withActor(actorOf(a[5])) }),
    setParam: (a, r) => ({ cause: `publish ${a[0]} ${(r as { version?: string })?.version ?? ""}`.trim(), ...withActor(typeof a[3] === "string" ? a[3] : undefined) }),
    setActiveVersion: (a) => ({ cause: `activate ${a[0]} ${a[1]}` }),
    deleteWorkflow: (a) => ({ cause: `delete ${a[0]}` }),
    publishStep: (a, r) => ({ cause: `publish ${a[0]} ${(r as { version?: string })?.version ?? ""}`.trim(), ...withActor(actorOf(a[4])) }),
    setActiveStepVersion: (a) => ({ cause: `activate ${a[0]} ${a[1]}` }),
    deleteStep: (a) => ({ cause: `delete ${a[0]}` }),
    deleteStepsByPublisher: (a) => ({ cause: `delete the steps of ${a[0]}` }),
    publishApp: (a, r) => ({ cause: `publish ${a[0]} ${(r as { version?: string })?.version ?? ""}`.trim(), ...withActor(actorOf(a[3])) }),
    setActiveAppVersion: (a) => ({ cause: `activate ${a[0]} ${a[1]}` }),
    addAppRelease: (a) => ({ cause: `release ${a[0]} ${(a[1] as { version?: string })?.version ?? ""}`.trim(), ...withActor((a[1] as { by?: string })?.by) }),
    setAppLive: (a) => ({ cause: `release ${a[0]} ${a[1] ?? "latest"}` }),
    deleteApp: (a) => ({ cause: `delete ${a[0]}` }),
  };
  return new Proxy(ws, {
    get(target, prop) {
      // The store's own `this`: a getter or a method may read its private fields.
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = v as (...args: unknown[]) => unknown;
      const touchOf = typeof prop === "string" ? causes[prop] : undefined;
      if (!touchOf) return fn.bind(target);
      return async (...args: unknown[]) => {
        const res = await fn.apply(target, args);
        // A delete that found nothing changed nothing.
        if (res !== false) touch(touchOf(args, res));
        return res;
      };
    },
  });
}

const withActor = (actor: string | undefined): { actor?: string } => (actor ? { actor } : {});

// ── boot ─────────────────────────────────────────────────────────────────

/**
 * The history a server runs, or null: off by `history: false` or
 * `STRUT_HISTORY=0`, with no graph, or with no `git` (said in one line).
 */
export async function openHistory(
  o: { history?: boolean; graph?: GraphBackend } & Omit<HistoryDeps, "git">,
  env: NodeJS.ProcessEnv = bootEnv(),
): Promise<History | null> {
  if (o.history === false || (o.history === undefined && env["STRUT_HISTORY"] === "0")) return null;
  if (!o.graph) return null;
  const git = await findGit(env);
  if ("missing" in git) {
    console.log(`[history] off: ${git.missing}`);
    return null;
  }
  return createHistory({ ...o, git: git.path });
}
