/**
 * What a check's paid runs have cost, by the subject each verified: a
 * running total kept beside the check's run bucket, at
 * `<dataDir>/checks/<id>/spend.json`. The verify pass adds a run's
 * `reportedCost` when it keeps the run (src/verify.ts), so `costOf` — read
 * on every `GET /claims` — and the per-subject daily budget read one small
 * file per check, never the check's runs.
 *
 * No file means no tally yet: a check from before it, or a tally that could
 * not be written. The verifier then recounts the bucket once, run by run,
 * and writes the file.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One subject's spend on one check: all time, and on the newest UTC day
 *  it spent anything. */
export interface SubjectSpend {
  usd: number;
  day: string;
  dayUsd: number;
}

/** By subject key (`step:<type>`, `workflow:<name>`, …). */
export type CheckSpend = Record<string, SubjectSpend>;

/** `YYYY-MM-DD`, UTC. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function spendFile(dataDir: string, checkId: string): string {
  if (!checkId || checkId === "." || checkId === ".." || /[/\\]/.test(checkId)) throw new Error(`Invalid check id "${checkId}"`);
  return join(dataDir, "checks", checkId, "spend.json");
}

/** The tally, or null when there is none (or it cannot be read): recount. */
export async function readSpend(dataDir: string, checkId: string): Promise<CheckSpend | null> {
  try {
    const parsed = JSON.parse(await readFile(spendFile(dataDir, checkId), "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CheckSpend) : null;
  } catch {
    return null;
  }
}

/** Replace the tally whole (a temp file renamed over it). */
export async function writeSpend(dataDir: string, checkId: string, spend: CheckSpend): Promise<void> {
  const file = spendFile(dataDir, checkId);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(spend), "utf-8");
  await rename(tmp, file);
}

/** Drop the tally, so the next read recounts. */
export async function dropSpend(dataDir: string, checkId: string): Promise<void> {
  await rm(spendFile(dataDir, checkId), { force: true });
}

/** `spend` with one run's cost added, on the UTC day it was spent. */
export function addSpend(spend: CheckSpend, subject: string, usd: number, at: number): CheckSpend {
  const day = utcDay(at);
  const was = spend[subject];
  const dayUsd = !was || day > was.day ? usd : day === was.day ? was.dayUsd + usd : was.dayUsd;
  return { ...spend, [subject]: { usd: (was?.usd ?? 0) + usd, day: was && was.day > day ? was.day : day, dayUsd } };
}

/** What one subject spent on `day`. */
export function spentOn(spend: SubjectSpend | undefined, day: string): number {
  return spend && spend.day === day ? spend.dayUsd : 0;
}
