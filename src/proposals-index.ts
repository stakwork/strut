import { mkdir, opendir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "./jobs.js";
import type { Proposal, ProposalFilter, ProposalStatus } from "./proposals.js";

/**
 * The proposals INDEX (plans/proposals-index-perf.md): one per root, shared by
 * every caller, built once (streamed, bounded concurrency) and updated by
 * every write. A list answers from memory and never touches the disk; only
 * `readProposal` (GET /proposals/:id) reads a file.
 *
 * What it holds, and why (the simplest robust option): a FULL record for
 * everything still in play — pending, accepted (being applied), failed (a
 * retry runs the recorded `input`, and a step's `after` reads the inputs of
 * pending/accepted/failed ones) — and the COMPACTED record for what is over
 * (applied, rejected): the tool `input` (the big payload) and a large
 * `result.output` replaced by a small marker. Pending records are few, so a
 * list still carries `input` for the ones a person decides on; the decided
 * history is small however long it grows. The files are compacted the same
 * way, AFTER the step ran (the write that records `applied` / `rejected`), and
 * a legacy directory is compacted — and old decided files archived — in the
 * background after the first boot. Nothing manual.
 */

/** Counts the disk reads of record files (the index build, `readProposal`):
 *  what the tests and the benchmark assert a poll never does. */
export const proposalIoStats = { fileReads: 0 };

const envNum = (name: string, dflt: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
/** `STRUT_PROPOSALS_CACHE_MS`: how long a list answer is reused (default 1000; 0 = none, overlapping calls still share one). */
export const cacheMs = (): number => envNum("STRUT_PROPOSALS_CACHE_MS", 1000);
/** `STRUT_PROPOSALS_RETENTION_DAYS`: decided records older than this move to `<root>/archive/` (default 30; 0 = keep forever). */
export const retentionDays = (): number => envNum("STRUT_PROPOSALS_RETENTION_DAYS", 30);
/** `STRUT_PROPOSALS_COMPACT`: strip a decided record's `input` (default on; `0` / `false` off). */
export const compactOn = (): boolean => !["0", "false"].includes((process.env["STRUT_PROPOSALS_COMPACT"] ?? "").toLowerCase());

const BUILD_CONCURRENCY = 32;
const MAINTAIN_CONCURRENCY = 8;
const OUTPUT_KEEP_BYTES = 4096;

// ── compaction ─────────────────────────────────────────────────────────────

/** Over for good: `failed` is not (it may be accepted again, with its input). */
export const isFinal = (p: Proposal): boolean => p.status === "applied" || p.status === "rejected";
const marker = (v: unknown) => ({ _compacted: true, bytes: JSON.stringify(v)?.length ?? 0 });
export const isCompacted = (p: Proposal): boolean => !!p.input && typeof p.input === "object" && (p.input as { _compacted?: unknown })._compacted === true;

/** The record with its payloads replaced by markers; everything a card, a
 *  brief or `proposalResultLines` reads is kept. Idempotent. */
export function compactOf(p: Proposal): Proposal {
  if (isCompacted(p)) return p;
  const out: Proposal = { ...p, input: marker(p.input) };
  if (out.decision?.input !== undefined) out.decision = { ...out.decision, input: marker(out.decision.input) };
  if (out.result && out.result.output !== undefined && JSON.stringify(out.result.output)?.length! > OUTPUT_KEEP_BYTES) {
    out.result = { ...out.result, output: marker(out.result.output) };
  }
  return out;
}

/** What is stored for `p` now. */
export const storedForm = (p: Proposal): Proposal => (compactOn() && isFinal(p) ? compactOf(p) : p);

function archiveDue(p: Proposal): boolean {
  const days = retentionDays();
  if (!days || !isFinal(p)) return false;
  const at = Date.parse(p.decision?.at ?? p.result?.at ?? p.createdAt);
  return Number.isFinite(at) && Date.now() - at > days * 86_400_000;
}
const needsMaintenance = (p: Proposal): boolean => (compactOn() && isFinal(p) && !isCompacted(p)) || archiveDue(p);

// ── the files ──────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** The record on disk (the archive too), never the index. */
export async function readProposalFile(root: string, id: string): Promise<Proposal | null> {
  if (!ID_RE.test(id)) return null;
  for (const dir of [root, join(root, "archive")]) {
    try {
      proposalIoStats.fileReads++;
      return JSON.parse(await readFile(join(dir, `${id}.json`), "utf-8")) as Proposal;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Whole, through a temp file and a rename, as a job record is written. */
async function writeFileAt(dir: string, p: Proposal): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${p.id}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(p, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

// ── the index ──────────────────────────────────────────────────────────────

export interface ProposalPage {
  proposals: Proposal[];
  /** Every match, before `offset` / `limit`. */
  total: number;
  /** The `offset` of the next page; absent on the last. */
  next?: number;
}

interface Memo {
  gen: number;
  at: number;
  settled: boolean;
  value: Promise<unknown>;
}

export class ProposalIndex {
  private byId = new Map<string, Proposal>();
  private order: Proposal[] | null = null;
  private memos = new Map<string, Memo>();
  /** Bumped by every change: a memo of an older one is never served. */
  private gen = 0;
  readonly ready: Promise<void>;
  /** The background compaction / archival of legacy files; resolves when done. */
  maintenance: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {
    this.ready = this.build().catch(() => {});
  }

  private changed(): void {
    this.gen++;
    this.order = null;
  }

  private put(p: Proposal): void {
    this.byId.set(p.id, storedForm(p));
    this.changed();
  }

  /** The one writer: the file, then the index (and so the caches). Returns what was stored. */
  async write(p: Proposal): Promise<Proposal> {
    await writeFileAt(this.root, storedForm(p));
    this.put(p);
    return this.byId.get(p.id)!;
  }

  private remove(id: string): void {
    this.byId.delete(id);
    this.changed();
  }

  private async build(): Promise<void> {
    let dir;
    try {
      dir = await opendir(this.root);
    } catch {
      return;
    }
    const active = new Set<Promise<void>>();
    const spawn = async (fn: () => Promise<void>, limit: number) => {
      while (active.size >= limit) await Promise.race(active);
      const pr: Promise<void> = fn().catch(() => {}).finally(() => active.delete(pr));
      active.add(pr);
    };
    const legacy: string[] = [];
    for await (const ent of dir) {
      const name = ent.name;
      if (!name.endsWith(".json") || !ent.isFile()) continue;
      await spawn(async () => {
        proposalIoStats.fileReads++;
        const p = JSON.parse(await readFile(join(this.root, name), "utf-8")) as Proposal;
        // A write that landed while the build read is newer: it stays.
        if (typeof p.id !== "string" || this.byId.has(p.id)) return;
        this.byId.set(p.id, storedForm(p));
        if (needsMaintenance(p)) legacy.push(p.id);
      }, BUILD_CONCURRENCY);
    }
    await Promise.all(active);
    this.changed();
    if (legacy.length) this.maintenance = this.maintain(legacy);
  }

  /** Compact (and archive, when due) legacy decided files, a few at a time. */
  private async maintain(ids: string[]): Promise<void> {
    const active = new Set<Promise<void>>();
    for (const id of ids) {
      while (active.size >= MAINTAIN_CONCURRENCY) await Promise.race(active);
      const pr: Promise<void> = this.maintainOne(id).catch(() => {}).finally(() => active.delete(pr));
      active.add(pr);
    }
    await Promise.all(active);
  }

  private async maintainOne(id: string): Promise<void> {
    const file = join(this.root, `${id}.json`);
    await withLock(file, async () => {
      const p = await readProposalFile(this.root, id);
      if (!p || !isFinal(p)) return;
      if (archiveDue(p)) {
        await writeFileAt(join(this.root, "archive"), compactOn() ? compactOf(p) : p);
        await unlink(file).catch(() => {});
        this.remove(id);
      } else if (compactOn() && !isCompacted(p)) {
        await writeFileAt(this.root, compactOf(p));
      }
    });
  }

  private sorted(): Proposal[] {
    return (this.order ??= [...this.byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1)));
  }

  /** Newest first. `where` is the caller's visibility rule, applied before the page is cut. */
  async query(filter: ProposalFilter = {}, opts: { offset?: number; limit?: number; where?: (p: Proposal) => boolean } = {}): Promise<ProposalPage> {
    await this.ready;
    const statuses = filter.status === undefined ? undefined : new Set<ProposalStatus>(Array.isArray(filter.status) ? filter.status : [filter.status]);
    const offset = opts.offset ?? 0;
    const proposals: Proposal[] = [];
    let total = 0;
    for (const p of this.sorted()) {
      if (filter.job !== undefined && p.by.job !== filter.job) continue;
      if (filter.session !== undefined && p.by.session !== filter.session) continue;
      if (filter.runId !== undefined && p.by.runId !== filter.runId) continue;
      if (statuses && !statuses.has(p.status)) continue;
      if (opts.where && !opts.where(p)) continue;
      if (total >= offset && (opts.limit === undefined || proposals.length < opts.limit)) proposals.push(p);
      total++;
    }
    return { proposals, total, ...(opts.limit !== undefined && offset + proposals.length < total ? { next: offset + proposals.length } : {}) };
  }

  /** Single-flight + a short cache: overlapping calls with one `key` share
   *  one computation, and its answer stands for `STRUT_PROPOSALS_CACHE_MS`
   *  unless something is written first (read-your-writes). */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.memos.get(key);
    if (hit && hit.gen === this.gen && (!hit.settled || now - hit.at < cacheMs())) return hit.value as Promise<T>;
    if (this.memos.size >= 256) for (const [k, m] of this.memos) if (m.settled && now - m.at >= cacheMs()) this.memos.delete(k);
    if (this.memos.size >= 1024) this.memos.clear();
    const entry: Memo = { gen: this.gen, at: now, settled: false, value: fn() };
    this.memos.set(key, entry);
    entry.value.then(
      () => {
        entry.at = Date.now();
        entry.settled = true;
      },
      () => {
        if (this.memos.get(key) === entry) this.memos.delete(key);
      },
    );
    return entry.value as Promise<T>;
  }
}

const indexes = new Map<string, ProposalIndex>();

/** The root's index: built on first use, shared by every caller. */
export function proposalIndex(root: string): ProposalIndex {
  let idx = indexes.get(root);
  if (!idx) indexes.set(root, (idx = new ProposalIndex(root)));
  return idx;
}

/** Forget a root's index (a test's "restart": the next use rebuilds from the files). */
export function dropProposalIndex(root: string): void {
  indexes.delete(root);
}
