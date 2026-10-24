// Fixes the fixer turned down that are said the same, vowels included
// (lingo.ts `assess`'s `pending`: Etoy → Itoi, never Mark → Mike), counted
// so the same fix made again is learned (dictation/correction). Only the
// pair, a count and when it was last made, never the sentence. A file of
// the step's own under dataDir, not memory: a pending pair is no fact about
// the user's words (memory/lexicon would list it, and recall find it), and
// it is dropped after 30 days. Leading underscore: skipped by registry
// discovery.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Mishearing } from "../../../audio/lingo.js";

/** How long a turned-down fix waits for the same fix again. */
export const PENDING_DAYS = 30;
const DAY_MS = 86_400_000;

export interface PendingPair {
  heard: string;
  written: string;
  /** How many times the user made this fix within PENDING_DAYS of the last. */
  count: number;
  /** When it was last made, ms since the epoch. */
  at: number;
}

export const pendingFile = (dataDir: string) => join(dataDir, "audio", "dictation-pending.json");

/** The same pair: dictation's side without case, the user's as written (Itoi, not itoi). */
const same = (p: { heard: string; written: string }, q: { heard: string; written: string }) =>
  p.heard.toLowerCase() === q.heard.toLowerCase() && p.written === q.written;

function read(file: string, now: number): PendingPair[] {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8"));
    return (Array.isArray(rows) ? rows : []).filter((r): r is PendingPair =>
      typeof r?.heard === "string" && typeof r?.written === "string" && typeof r?.count === "number" && typeof r?.at === "number" && now - r.at <= PENDING_DAYS * DAY_MS);
  } catch {
    return [];
  }
}

function write(file: string, rows: PendingPair[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // Only these four fields: a pair is never stored with its sentence.
  writeFileSync(tmp, JSON.stringify(rows.map(({ heard, written, count, at }) => ({ heard, written, count, at }))));
  renameSync(tmp, file);
}

/** Counts each turned-down pair once per edit, drops those older than
 *  PENDING_DAYS, and returns the pairs now made in a second edit (or more).
 *  Synchronous, so two corrections at once never lose a count. */
export function recordPending(dataDir: string, pairs: Mishearing[], now = Date.now()): Mishearing[] {
  const file = pendingFile(dataDir);
  const rows = read(file, now);
  const due: Mishearing[] = [];
  for (const p of pairs.filter((p, i) => !pairs.slice(0, i).some((q) => same(p, q)))) {
    const row = rows.find((r) => same(r, p));
    if (row) {
      row.count++;
      row.at = now;
      due.push(p);
    } else rows.push({ heard: p.heard, written: p.written, count: 1, at: now });
  }
  write(file, rows);
  return due;
}

/** Forgets pairs that were learned. */
export function clearPending(dataDir: string, pairs: { heard: string; written: string }[], now = Date.now()): void {
  const file = pendingFile(dataDir);
  const rows = read(file, now);
  const kept = rows.filter((r) => !pairs.some((p) => same(r, p)));
  if (kept.length !== rows.length) write(file, kept);
}
