// A .docx as the docx/* steps see it: the ZIP's parts by name, the main
// document found through the package's relationships, and the parts it
// relates to (styles, numbering, comments, notes) found the same way. And
// where a step's .docx lives: this run's files — the job's directory on a
// job run, else the run's artifacts — or a served link to another's.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { jobFileUrl } from "../../../artifact-refs.js";
import { jobFilePath, jobRoot } from "../../../jobs.js";
import { readZip, writeZip, type ZipEntry } from "./_zip.js";
import { attr, children, parseXml, rootOf, serializeXml, type XNode } from "./_xml.js";

/** A .docx larger than this is not read. */
export const DOCX_MAX_BYTES = 25 * 1024 * 1024;

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL_COMMENTS = `${REL}/comments`;
export const COMMENTS_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";

export interface Rel {
  id: string;
  type: string;
  /** A part name inside the package, or the URL of an external target. */
  target: string;
  external: boolean;
}

export class Docx {
  readonly entries: ZipEntry[];
  /** The main document part, `word/document.xml` in every Word file. */
  readonly main: string;

  constructor(bytes: Buffer) {
    if (bytes.length > DOCX_MAX_BYTES) throw new Error(`the .docx is ${bytes.length} bytes, over the ${DOCX_MAX_BYTES}-byte limit`);
    try {
      this.entries = readZip(bytes);
    } catch (err) {
      throw new Error(`not a .docx (${(err as Error).message})`);
    }
    const office = this.rels("").find((r) => r.type.endsWith("/officeDocument"));
    this.main = office?.target ?? "word/document.xml";
    if (!this.has(this.main)) throw new Error("not a .docx (no word/document.xml)");
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  text(name: string): string | undefined {
    return this.entries.find((e) => e.name === name)?.data.toString("utf8");
  }

  xml(name: string): XNode[] | undefined {
    const t = this.text(name);
    return t === undefined ? undefined : parseXml(t);
  }

  set(name: string, xml: XNode[] | string): void {
    const data = Buffer.from(typeof xml === "string" ? xml : serializeXml(xml), "utf8");
    const at = this.entries.find((e) => e.name === name);
    if (at) at.data = data;
    else this.entries.push({ name, data });
  }

  /** The relationships of `part` (`""`: the package's own). */
  rels(part: string): Rel[] {
    const dir = posix.dirname(part);
    const relsName = part ? posix.join(dir, "_rels", `${posix.basename(part)}.rels`) : "_rels/.rels";
    const nodes = this.xml(relsName);
    if (!nodes) return [];
    return children(rootOf(nodes), "Relationship").map((r) => {
      const external = attr(r, "TargetMode") === "External";
      const target = attr(r, "Target") ?? "";
      return {
        id: attr(r, "Id") ?? "",
        type: attr(r, "Type") ?? "",
        external,
        target: external ? target : target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(part ? dir : "", target)),
      };
    });
  }

  /** The part the main document relates to by `type` (its last segment). */
  related(type: string): string | undefined {
    const rel = this.rels(this.main).find((r) => !r.external && r.type.endsWith(`/${type}`));
    return rel && this.has(rel.target) ? rel.target : undefined;
  }

  bytes(): Buffer {
    return writeZip(this.entries);
  }
}

// ── where a step's .docx lives ───────────────────────────────────────────────

type Ctx = StepContext<StrutCapabilities>;

/** One file of a run's or a job's files: its bytes' home and its served link. */
export interface DocFile {
  /** Relative to the job's directory or the run's artifacts. */
  path: string;
  /** The served form, `/jobs/<job>/files/…` or `/artifacts/<runId>/…`. */
  url: string;
}

interface Scope {
  job?: { name: string; root: string };
  runId: string;
}

function dataDirOf(ctx: Ctx): string {
  return ctx.services?.dataDir ?? join(tmpdir(), "strut");
}

/** This run's own files: the job's directory on a job run, else its artifacts. */
function ownScope(ctx: Ctx): Scope {
  return ctx.job ? { job: { name: ctx.job, root: jobRoot(dataDirOf(ctx), ctx.job) }, runId: ctx.runId } : { runId: ctx.runId };
}

async function scopeRoot(ctx: Ctx, scope: Scope): Promise<string> {
  if (scope.job) return scope.job.root;
  const artifacts = ctx.services?.artifacts;
  if (!artifacts) throw new Error("this run has no job and no artifacts capability to keep files in");
  return artifacts.dir(scope.runId);
}

/** A path as given → the scope it is in and its path there. A served link
 *  names another job's or run's files; a relative path is this run's; an
 *  absolute one must be inside this run's files. */
async function locate(ctx: Ctx, path: string, own: boolean): Promise<{ scope: Scope; rel: string; own: boolean }> {
  const link = path.replace(/[?#].*$/, "");
  const job = /^\/jobs\/([^/]+)\/files\/(.+)$/.exec(link);
  const run = job ? null : /^\/artifacts\/([^/]+)\/(.+)$/.exec(link);
  if (job || run) {
    const id = decodeURIComponent((job ?? run)![1]!);
    const scope: Scope = job ? { job: { name: id, root: jobRoot(dataDirOf(ctx), id) }, runId: ctx.runId } : { runId: id };
    const mine = ownScope(ctx);
    const isOwn = job ? id === mine.job?.name : !mine.job && id === mine.runId;
    if (own && !isOwn) throw new Error(`${path} is not this run's file: write into this run's own files (a path relative to them)`);
    return { scope, rel: decodeURIComponent((job ?? run)![2]!), own: isOwn };
  }
  const scope = ownScope(ctx);
  if (isAbsolute(path)) {
    const root = await scopeRoot(ctx, scope);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside this run's files (${root})`);
    return { scope, rel: rel.split(sep).join("/"), own: true };
  }
  return { scope, rel: path.replace(/^\.?\/+/, ""), own: true };
}

function urlOf(scope: Scope, rel: string): string {
  return scope.job ? jobFileUrl(scope.job.name, rel) : `/artifacts/${scope.runId}/${rel}`;
}

/** Read a file: this run's (a relative path), or another's by its served link. */
export async function readDocFile(ctx: Ctx, path: string): Promise<DocFile & { bytes: Buffer; own: boolean }> {
  const { scope, rel, own } = await locate(ctx, path, false);
  let bytes: Buffer;
  try {
    if (scope.job) bytes = await readFile(jobFilePath(scope.job.root, rel));
    else {
      const artifacts = ctx.services?.artifacts;
      if (!artifacts) throw new Error("no artifacts capability");
      bytes = Buffer.from(await artifacts.read(scope.runId, rel));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error(`no file ${path} in ${scope.job ? `job ${scope.job.name}` : `run ${scope.runId}`}`);
    throw err;
  }
  return { path: rel, url: urlOf(scope, rel), bytes, own };
}

/** Write a file into this run's own files. */
export async function writeDocFile(ctx: Ctx, path: string, content: Buffer | string): Promise<DocFile> {
  const { scope, rel } = await locate(ctx, path, true);
  if (scope.job) {
    const abs = jobFilePath(scope.job.root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  } else {
    const artifacts = ctx.services?.artifacts;
    if (!artifacts) throw new Error("this run has no job and no artifacts capability to write into");
    await artifacts.write(scope.runId, rel, content);
  }
  return { path: rel, url: urlOf(scope, rel) };
}
