/**
 * The HISTORY (plans/concept-history.md): what this strut held, when, and
 * which run changed it — the whole workspace written as a package directory
 * (`packageFiles(…, EVERYTHING)`, src/packages/build.ts) and committed to a
 * bare git repository under the data directory each time strut hears a
 * write. The graph stays the source; git only records, and nothing reads
 * it to serve the graph. `history/read` (src/steps/lib/history/read.ts) is
 * the door.
 *
 *   <dataDir>/history.git         the repository, bare, branch `main`
 *   <dataDir>/history.git/work/   the work tree a snapshot is written into
 *                                 (inside the repository, so it moves and is
 *                                 backed up with it; rebuilt by any snapshot)
 *
 * TOUCHES (§3): a run's graph view tells the history when it flushes its
 * writes (`bindGraph`, src/graph-writes.ts — schema writes included), and
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
 * GIT: run through `runProcess` (src/shell.ts) with the binary found on
 * PATH, no user or system config, no hooks, no signing. On macOS
 * `/usr/bin/git` is a shim that asks to install the Command Line Tools, so
 * `xcode-select -p` is asked first and a boot never raises that dialog
 * (`findGit`). No `git`: no history, said once at boot.
 */
import { createHash } from "node:crypto";
import { access, constants, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { AppsCapability } from "./apps/apps.js";
import type { ClaimsAuthoring } from "./claims-authoring.js";
import { bootEnv } from "./env.js";
import type { GraphBackend } from "./graph/backend.js";
import { EVERYTHING, newWholeMemo, packageFiles, type WholeMemo } from "./packages/build.js";
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
/** The branch every snapshot commits to. */
export const HISTORY_BRANCH = "main";

/** What touched the history: the commit's cause, who, and the run. */
export interface HistoryTouch {
  /** `run <id>`, `proposal <id>`, `publish <name> <version>`,
   *  `install <package>@<digest>`, `boot`, `sync`… */
  cause: string;
  actor?: string;
  /** A run whose writes this is: a `Run:` trailer. */
  run?: string;
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
  /** Boot is done: the first snapshot, cause `boot`, and every touch from
   *  now on. Before it, touches wait. */
  start(): void;
  /** Commit what is waiting, then stop. */
  close(): Promise<void>;
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

/** The commands `git()` runs for a reader: they read, nothing else. */
const READ_COMMANDS = new Set(["log", "show", "diff", "rev-list", "rev-parse", "ls-tree", "cat-file"]);

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

  let ready: Promise<void> | undefined;
  const ensureRepo = () =>
    (ready ??= (async () => {
      if (!(await stat(join(dir, "HEAD")).catch(() => null))) {
        await mkdir(dirname(dir), { recursive: true });
        await runProcess({ cmd: deps.git, args: [...GIT_FLAGS, "init", "--bare", "-q", dir], cwd: deps.dataDir, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEVICE } }).then((r) => {
          if (r.code !== 0) throw new Error(`git init: ${r.stderr.trim()}`);
        });
        await git(["symbolic-ref", "HEAD", `refs/heads/${HISTORY_BRANCH}`]);
      }
      await mkdir(work, { recursive: true });
    })().catch((err) => {
      ready = undefined;
      throw err;
    }));

  // What the work tree holds, by path → sha1 of its bytes: a file is written
  // only when its bytes change, so git's stat cache stays good. Read from
  // disk on the first snapshot.
  let onDisk: Map<string, string> | undefined;
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
  /** The tree `main` points at, once read. */
  let headTree: string | null | undefined;
  let head: string | null | undefined;
  let first = true;

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
    onDisk ??= await walk();
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
    if (!written && !removed && !first) return { ...result, ms: Date.now() - started };
    first = false;
    await git(["add", "-A"], { workTree: true });
    const tree = (await git(["write-tree"])).trim();
    if (headTree === undefined) {
      head = (await run(["rev-parse", "-q", "--verify", `refs/heads/${HISTORY_BRANCH}`])).stdout.trim() || null;
      headTree = head ? (await git(["rev-parse", `${head}^{tree}`])).trim() : null;
    }
    if (tree === headTree) return { ...result, ms: Date.now() - started };
    const when = `${Math.floor(Date.now() / 1000)} +0000`;
    const author = take.actor || HISTORY_ACTOR;
    const commit = (
      await git(["commit-tree", "--no-gpg-sign", tree, ...(head ? ["-p", head] : [])], {
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
    await git(["update-ref", `refs/heads/${HISTORY_BRANCH}`, commit, ...(head ? [head] : [])]);
    head = commit;
    headTree = tree;
    if (++commits % 500 === 0) await run(["gc", "--auto", "--quiet"]).catch(() => undefined);
    return { ...result, commit, changed: true, ms: Date.now() - started };
  }
  let commits = 0;

  // ── the queue ──
  let pending: Pending | null = null;
  /** The last snapshot's result. */
  let last: SnapshotResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let started = false;
  let closed = false;
  let holds = 0;
  const waitingViews = new Set<() => Promise<void>>();

  const add = (t: HistoryTouch) => {
    pending ??= { causes: [], runs: [], firstAt: Date.now() };
    // Inside a hold, its own cause replaces what it publishes.
    if (holds === 0 && !pending.causes.includes(t.cause)) pending.causes.push(t.cause);
    if (holds === 0 && !pending.actor && t.actor) pending.actor = t.actor;
    if (t.run && !pending.runs.includes(t.run)) pending.runs.push(t.run);
  };
  const schedule = (now = false) => {
    if (!pending || !started || holds > 0 || closed) return;
    if (timer) clearTimeout(timer);
    const delay = now ? 0 : Math.max(0, Math.min(debounce, pending.firstAt + maxDelay - Date.now()));
    timer = setTimeout(() => void drain(), delay);
    timer.unref?.();
  };
  /** Run the pending snapshot now, after any in flight; its result. */
  const drain = (): Promise<SnapshotResult | undefined> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const p = chain.then(async () => {
      const take = pending;
      pending = null;
      if (!take) return undefined;
      try {
        return (last = await snapshot(take));
      } catch (err) {
        console.warn(`[history] snapshot (${take.causes[0] ?? "sync"}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    });
    chain = p.catch(() => undefined);
    return p;
  };

  const history: History = {
    dir,
    waiting(flush) {
      if (!closed) waitingViews.add(flush);
    },
    touch(t, from) {
      if (from) waitingViews.delete(from);
      if (closed) return;
      add(t);
      schedule();
    },
    async settle() {
      const views = [...waitingViews];
      waitingViews.clear();
      await Promise.all(views.map((f) => f().catch(() => undefined)));
      if (!started) return;
      await drain();
    },
    async sync(actor) {
      const views = [...waitingViews];
      waitingViews.clear();
      await Promise.all(views.map((f) => f().catch(() => undefined)));
      if (closed) return undefined;
      add({ cause: "sync", actor: actor ?? HISTORY_ACTOR });
      if (!started) return undefined;
      // A timer may have taken the touch first: then its snapshot is this one.
      return (await drain()) ?? last;
    },
    async git(args) {
      if (!READ_COMMANDS.has(args[0] ?? "") || args.some((a) => a.startsWith("--output"))) throw new Error(`history: git ${args.join(" ")} is not a read`);
      await ensureRepo();
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
        pending ??= { causes: [], runs: [], firstAt: Date.now() };
        pending.causes = [t.cause, ...pending.causes.filter((c) => c !== t.cause)];
        pending.actor = t.actor ?? pending.actor;
        if (t.run && !pending.runs.includes(t.run)) pending.runs.push(t.run);
        schedule();
      }
    },
    start() {
      if (started || closed) return;
      started = true;
      // What the seeds published is the boot's.
      pending = { causes: ["boot"], actor: HISTORY_ACTOR, runs: pending?.runs ?? [], firstAt: Date.now() };
      schedule(true);
    },
    async close() {
      if (closed) return;
      const views = [...waitingViews];
      waitingViews.clear();
      await Promise.all(views.map((f) => f().catch(() => undefined)));
      if (started && pending) await drain();
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await chain;
    },
  };
  return history;
}

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
