/**
 * PATCHES (plans/managed-packages.md §1, §2): what a package update needs
 * of git, and the patch FILE.
 *
 * An installed item this strut edited (a fork) is its release plus a local
 * patch. An update REPLAYS it: a three-way merge of the fork (`ours`), the
 * release it was made from (`base`) and the new release (`theirs`) — one
 * file for a workflow or a step (`mergeText`), per path for an app
 * (`mergeTrees`). What does not merge is handed in as a patch file: a git
 * patch from the release to the merged result, which `applyPatch` puts on
 * the release's own files.
 *
 * The file is what `git diff --binary` writes between two directories laid
 * out as the package is, after header lines `git apply` skips:
 *
 *     package: acme/linear
 *     onto: sha256:<the release it applies to>
 *     over: workflows/sync.yaml=<hash> apps/issues=<tree hash>
 *
 * `over` names each fork the patch covers, by its path in the package, with
 * its active hash when the patch was made: applying it to an item that has
 * moved since is refused, so a later edit is never dropped. A patch is kept
 * by the sha256 of its bytes (`PatchStore`), the way the cache names a
 * package.
 *
 * Every command runs in a scratch directory with GIT_CEILING_DIRECTORIES
 * set to its parent: a data folder inside a checkout is otherwise read as
 * that repository, and `git apply` there exits 0 having applied nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findGit } from "../history.js";
import { runProcess } from "../shell.js";
import { treeFiles } from "../version.js";
import { PACKAGE_DIGEST } from "./format.js";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_FLAGS = ["-c", "core.quotepath=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fsmonitor=false"];

let found: ReturnType<typeof findGit> | undefined;
/** The git a package update runs, found once per process, or why there is none. */
export function packageGit(): ReturnType<typeof findGit> {
  return (found ??= findGit());
}

async function git(bin: string, args: string[], cwd: string, stdin?: string) {
  return runProcess({
    cmd: bin,
    args: [...GIT_FLAGS, ...args],
    cwd,
    ...(stdin !== undefined ? { stdin } : {}),
    env: {
      GIT_CEILING_DIRECTORIES: dirname(cwd),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    timeoutMs: 120_000,
    maxOutputChars: 64 * 1024 * 1024,
  });
}

/** A fresh directory under `scratch`. */
async function tempDir(scratch: string): Promise<string> {
  const dir = join(scratch, randomBytes(6).toString("hex"));
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Not text a merge may rewrite: git's own test (a NUL in the first 8000
 *  bytes), or bytes that are not UTF-8 (they would not survive the merge). */
export const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0) || !Buffer.from(b.toString("utf8"), "utf8").equals(b);

/** The labels on a conflict's markers. */
const LABELS = ["-L", "local", "-L", "base", "-L", "upstream"];

/** A three-way merge of one text: `clean` when git left no markers.
 *  A conflict keeps both sides and the base between markers (diff3). */
export async function mergeText(bin: string, scratch: string, t: { base: string; ours: string; theirs: string }): Promise<{ text: string; clean: boolean }> {
  const dir = await tempDir(scratch);
  try {
    await Promise.all([writeFile(join(dir, "ours"), t.ours), writeFile(join(dir, "base"), t.base), writeFile(join(dir, "theirs"), t.theirs)]);
    const r = await git(bin, ["merge-file", "-p", "--diff3", ...LABELS, "ours", "base", "theirs"], dir);
    // 0: clean; 1–127: that many conflicts; anything else: git failed.
    if (r.code === null || r.code < 0 || r.code > 127) throw new Error(`git merge-file failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return { text: r.stdout, clean: r.code === 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface TreeMerge {
  /** Paths the merge could not settle: changed by both sides and left with
   *  markers, or deleted by one side and changed by the other. */
  conflicts: string[];
  /** Binary files both sides changed: the release's was taken. */
  tookTheirs: string[];
}

/** A three-way merge of a directory into `out`, path by path (§2's table):
 *  a path one side changed is that side's; one both changed to the same
 *  bytes is those; text both changed goes through `mergeText` (markers are
 *  written, and the path is a conflict); a binary both changed is the
 *  release's. Covers what a tree hash covers (`treeFiles`). */
export async function mergeTrees(bin: string, scratch: string, dirs: { base: string; ours: string; theirs: string; out: string }): Promise<TreeMerge> {
  const [base, ours, theirs] = await Promise.all([treeFiles(dirs.base), treeFiles(dirs.ours), treeFiles(dirs.theirs)]);
  const read = async (dir: string, has: Set<string>, rel: string) => (has.has(rel) ? readFile(join(dir, ...rel.split("/"))) : undefined);
  const sets = { base: new Set(base), ours: new Set(ours), theirs: new Set(theirs) };
  const same = (a: Buffer | undefined, b: Buffer | undefined) => (a === undefined || b === undefined ? a === b : a.equals(b));
  const result: TreeMerge = { conflicts: [], tookTheirs: [] };
  for (const rel of [...new Set([...base, ...ours, ...theirs])].sort()) {
    const [b, o, t] = await Promise.all([read(dirs.base, sets.base, rel), read(dirs.ours, sets.ours, rel), read(dirs.theirs, sets.theirs, rel)]);
    let merged: Buffer | undefined;
    if (same(o, t) || same(b, t)) merged = o;
    else if (same(b, o)) merged = t;
    else if (o === undefined || t === undefined) {
      // Deleted by one side, changed by the other: the changed one is kept to look at.
      result.conflicts.push(rel);
      merged = o ?? t;
    } else if (isBinary(o) || isBinary(t) || (b !== undefined && isBinary(b))) {
      result.tookTheirs.push(rel);
      merged = t;
    } else {
      const m = await mergeText(bin, scratch, { base: b?.toString("utf8") ?? "", ours: o.toString("utf8"), theirs: t.toString("utf8") });
      if (!m.clean) result.conflicts.push(rel);
      merged = Buffer.from(m.text, "utf8");
    }
    if (merged === undefined) continue;
    const to = join(dirs.out, ...rel.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, merged);
  }
  return result;
}

/** The git patch from `<layout>/a` to `<layout>/b`, paths as they are under
 *  each (`a/workflows/sync.yaml`): `""` when the two are the same. */
export async function diffDirs(bin: string, layout: string): Promise<string> {
  await Promise.all([mkdir(join(layout, "a"), { recursive: true }), mkdir(join(layout, "b"), { recursive: true })]);
  const r = await git(bin, ["diff", "--no-index", "--no-prefix", "--binary", "--no-color", "--no-ext-diff", "--no-renames", "a", "b"], layout);
  if (r.code === 0) return "";
  if (r.code !== 1) throw new Error(`git diff failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  if (r.truncated) throw new Error("git diff: the patch is too large to keep");
  return r.stdout;
}

/** Apply a patch's body to the files under `dir`, all or nothing. Throws
 *  `patch_rejected:` with git's own words when it does not apply. */
export async function applyPatch(bin: string, dir: string, patch: string): Promise<void> {
  const body = patchBody(patch);
  if (!body.trim()) return;
  const r = await git(bin, ["apply", "-p1", "--whitespace=nowarn", "-"], dir, body);
  if (r.code !== 0) throw new Error(`patch_rejected: the patch does not apply to the release's files — ${r.stderr.trim() || `git apply exit ${r.code}`}`);
}

// ── The file ────────────────────────────────────────────────────────────────

export interface PatchHeader {
  package: string;
  /** The digest of the release the patch applies to. */
  onto: string;
  /** Each fork it covers: its path in the package → its active hash when
   *  the patch was made. */
  over: Record<string, string>;
}

const BODY_START = /^diff --git /m;

/** Everything from the first `diff --git` on. */
export function patchBody(patch: string): string {
  const at = patch.search(BODY_START);
  return at < 0 ? "" : patch.slice(at);
}

/** The header lines and the body as one patch file. */
export function formatPatch(header: PatchHeader, body: string): string {
  const over = Object.entries(header.over)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, hash]) => `${path}=${hash}`)
    .join(" ");
  return `package: ${header.package}\nonto: ${header.onto}\nover: ${over}\n${body}`;
}

/** A patch file's header, or the reason it is not one. */
export function parsePatch(patch: string): PatchHeader | string {
  const at = patch.search(BODY_START);
  const fields = new Map<string, string>();
  for (const line of (at < 0 ? patch : patch.slice(0, at)).split("\n")) {
    const m = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (m) fields.set(m[1]!, m[2]!.trim());
  }
  const pkg = fields.get("package");
  const onto = fields.get("onto");
  if (!pkg || !onto || !fields.has("over")) return "a patch file starts with three lines: package, onto and over";
  if (!PACKAGE_DIGEST.test(onto)) return `onto is the digest of the release the patch applies to (sha256:<64 hex>), not ${JSON.stringify(onto)}`;
  const over: Record<string, string> = {};
  for (const pair of fields.get("over")!.split(/\s+/).filter(Boolean)) {
    const eq = pair.lastIndexOf("=");
    if (eq <= 0 || eq === pair.length - 1) return `over lists the forks the patch covers as <path>=<hash>, not ${JSON.stringify(pair)}`;
    over[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (!Object.keys(over).length) return "over names no fork: a patch covers at least one";
  return { package: pkg, onto, over };
}

/** How big a patch is: the files it touches and the lines it adds and removes. */
export function patchStat(patch: string): { files: number; added: number; removed: number } {
  const out = { files: 0, added: 0, removed: 0 };
  for (const line of patchBody(patch).split("\n")) {
    if (line.startsWith("diff --git ")) out.files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) out.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) out.removed++;
  }
  return out;
}

/** A patch's name: the sha256 of its bytes. */
export const patchDigest = (patch: string): string => `sha256:${createHash("sha256").update(patch, "utf8").digest("hex")}`;

/** Patches by digest, under `<dataDir>/packages/patches/`: written once. */
export class PatchStore {
  constructor(readonly root: string) {}

  private fileOf(digest: string): string {
    if (!PACKAGE_DIGEST.test(digest)) throw new Error(`${JSON.stringify(digest)} is not a patch's digest (sha256:<64 hex>)`);
    return join(this.root, `${digest.replace(":", "-")}.patch`);
  }

  async put(patch: string): Promise<string> {
    const header = parsePatch(patch);
    if (typeof header === "string") throw new Error(`patch_invalid: ${header}`);
    const digest = patchDigest(patch);
    await mkdir(this.root, { recursive: true });
    await writeFile(this.fileOf(digest), patch, "utf8");
    return digest;
  }

  async get(digest: string): Promise<string | undefined> {
    try {
      const patch = await readFile(this.fileOf(digest), "utf8");
      if (patchDigest(patch) !== digest) throw new Error(`patch_corrupt: ${this.fileOf(digest)} no longer hashes to its name`);
      return patch;
    } catch (err: any) {
      if (err?.code === "ENOENT") return undefined;
      throw err;
    }
  }
}
