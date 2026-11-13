/**
 * A task's FILES (plans/human-steps.md §3, §5.5): what a worker may open,
 * named by the `human` step that made the task. They are the run's own
 * files, never copies — the job's directory on a job run, else the run's
 * artifacts, the place `run/files` reads — and the task keeps the list of
 * paths with where they are rooted (`TaskRecord.root`).
 *
 * An entry is a path, or a PATTERN: `*` and `?` match within one folder
 * (`photos/*`, `pages/page-??.png`; a folder's name may be one too), never
 * across a `/`, and a name that starts with `.` only when the pattern's
 * segment does too, as a shell's glob. Patterns are expanded when the task is MADE, so the
 * task's list is fixed; a file written later does not join it. A path that
 * is not a file, or a pattern that matches none, fails the step.
 */
import { readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ArtifactsCapability } from "../capabilities.js";
import { jobRoot } from "../jobs.js";
import { FILES_MAX } from "./tasks.js";

/** Whether an entry is a pattern rather than a path. */
export function isFilePattern(entry: string): boolean {
  return /[*?]/.test(entry);
}

/** The directory a run's task files are under: the job's directory on a
 *  job run, else the run's artifacts. */
export async function taskFilesRoot(o: { runId: string; job?: string; dataDir?: string; artifacts?: ArtifactsCapability }): Promise<string> {
  if (o.job) {
    if (!o.dataDir) throw new Error("task_files: this server keeps no job directories (no dataDir)");
    return jobRoot(o.dataDir, o.job);
  }
  if (!o.artifacts) throw new Error("task_files: this server keeps no run files (no artifacts capability)");
  return o.artifacts.dir(o.runId);
}

/** The entries as a task keeps them: each path checked to be a file under
 *  `root`, each pattern expanded to the files it matches (sorted), every
 *  file once, at most `FILES_MAX`. `where` names the root in an error. */
export async function resolveTaskFiles(root: string, entries: readonly string[], where = "the run's files"): Promise<string[]> {
  const base = resolve(root);
  const inside = (rel: string) => within(base, rel, where);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push(rel);
  };
  for (const entry of entries) {
    const segs = entry.split("/");
    if (!entry || entry.startsWith("/") || entry.includes("\\") || entry.includes("\0") || segs.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`task_files: not a path under ${where}: ${JSON.stringify(entry)}`);
    }
    if (!isFilePattern(entry)) {
      if (!(await isFile(inside(entry)))) throw new Error(`task_file_missing: ${JSON.stringify(entry)} is not a file under ${where}`);
      add(entry);
      continue;
    }
    const matched = await expand(base, segs, inside);
    if (!matched.length) throw new Error(`task_file_missing: no file under ${where} matches ${JSON.stringify(entry)}`);
    for (const rel of matched) add(rel);
  }
  if (out.length > FILES_MAX) throw new Error(`task_files: the files come to ${out.length}; a task names at most ${FILES_MAX}`);
  return out;
}

/** The files `segs` matches under `base`, relative and sorted. */
async function expand(base: string, segs: string[], inside: (rel: string) => string): Promise<string[]> {
  let prefixes = [""];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    const next: string[] = [];
    for (const prefix of prefixes) {
      if (!isFilePattern(seg)) {
        const rel = prefix ? `${prefix}/${seg}` : seg;
        if (last ? await isFile(inside(rel)) : await isDir(inside(rel))) next.push(rel);
        continue;
      }
      let names;
      try {
        names = await readdir(prefix ? inside(prefix) : base, { withFileTypes: true });
      } catch {
        continue;
      }
      const re = segmentRe(seg);
      for (const d of names) {
        if (d.name.startsWith(".") && !seg.startsWith(".")) continue;
        if (!re.test(d.name)) continue;
        if (last ? !d.isFile() : !d.isDirectory()) continue;
        next.push(prefix ? `${prefix}/${d.name}` : d.name);
      }
    }
    prefixes = next;
  }
  return prefixes.sort();
}

/** One segment of a pattern as a regex: `*` any run of characters, `?` one. */
function segmentRe(seg: string): RegExp {
  const body = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "s");
}

function within(base: string, rel: string, where: string): string {
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`task_files: ${JSON.stringify(rel)} is not under ${where}`);
  return abs;
}

async function isFile(abs: string): Promise<boolean> {
  return stat(abs).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function isDir(abs: string): Promise<boolean> {
  return stat(abs).then(
    (s) => s.isDirectory(),
    () => false,
  );
}
