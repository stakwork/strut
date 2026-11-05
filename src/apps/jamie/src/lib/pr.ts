// A pull request's card, its pure parts — tested by src/apps/jamie.test.ts:
// which artifact is a pull request, its state as a pill, its checks in a
// line, and the job turn Fix sends.
import type { Tone } from "./jobs";
import type { ArtifactRef } from "./types";

/** A pull request's address. */
export interface PrRef {
  repo: string;
  number: number;
  url: string;
}

/** As `github/pr-status` answers. */
export interface PrStatus {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  author?: string;
  head: string;
  base: string;
  headSha: string;
  body?: string;
  mergeable: boolean | null;
  checks: Array<{ name: string; status: "failed" | "running" | "passed" | "skipped"; url?: string }>;
  counts: { passed: number; failed: number; running: number; skipped: number; total: number };
}

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;

/** The pull request an artifact is: `kind: "pull_request"` with a GitHub
 *  link (its `url`, or a `url` in its content), else null. */
export function prOf(ref: Pick<ArtifactRef, "kind" | "url" | "content">): PrRef | null {
  if (ref.kind !== "pull_request") return null;
  let content = ref.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      // a bare link, or words
    }
  }
  const inContent = (content as { url?: unknown } | null | undefined)?.url;
  const url = ref.url ?? (typeof inContent === "string" ? inContent : typeof ref.content === "string" ? ref.content : "");
  const m = PR_URL.exec(url.trim());
  return m ? { repo: m[1]!, number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` } : null;
}

/** One card per pull request in a thread: the key two mentions share. */
export const prKey = (p: Pick<PrRef, "repo" | "number">) => `${p.repo.toLowerCase()}#${p.number}`;

export function prPill(state: PrStatus["state"] | string | undefined): { label: string; tone: Tone } {
  switch (state) {
    case "merged":
      return { label: "Merged", tone: "merged" };
    case "closed":
      return { label: "Closed", tone: "failed" };
    case "draft":
      return { label: "Draft", tone: "muted" };
    case "open":
      return { label: "Open", tone: "ok" };
    default:
      return { label: "Pull request", tone: "muted" };
  }
}

/** "2 of 3 checks passed", "1 failed", "running"; "" with none. */
export function checksLine(c: PrStatus["counts"]): string {
  if (!c.total) return "";
  const parts = [`${c.passed} of ${c.total} checks passed`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.running) parts.push(`${c.running} running`);
  return parts.join(" · ");
}

/** Merge is offered on an open PR GitHub has not found a conflict in. */
export const canMerge = (s: Pick<PrStatus, "state" | "mergeable">) => s.state === "open" && s.mergeable !== false;

/** Fix: the job's next turn, told which checks failed. */
export function fixPrompt(s: Pick<PrStatus, "repo" | "number" | "head" | "checks">): string {
  const failed = s.checks.filter((c) => c.status === "failed").map((c) => c.name);
  return `The checks on ${s.repo}#${s.number} failed: ${failed.join(", ")}. Find out why, fix it, and push the fix to ${s.head} — the same pull request.`;
}

/** Read again while it can still change. */
export const prLive = (state: PrStatus["state"] | undefined) => state !== "merged" && state !== "closed";
