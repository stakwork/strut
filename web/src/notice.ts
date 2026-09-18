// ── Wake-up notices ────────────────────────────────────────────────────────
//
// `[run-notification]` and `[verify-notification]` messages are written for
// the MODEL (src/ai/notifier.ts, src/ledger.ts): a headline, machine lines
// (`Output: <json>`, `claims: <json>`), then guidance on what to do next.
// This pulls one apart so the chat can show a person the headline and let
// them open the rest piece by piece. Anything unrecognized is kept in
// `notes` — a format drift shows up as text, never as a lost line.

export type ClaimStatus = "supported" | "refuted" | "unknown" | "stale";

/** Mirrors the server's `LastVerify` (src/verify.ts). */
export type LastVerify = { pending: true } | { ran: true } | { skipped: string; reason?: string } | { planned: string };

export interface LedgerCheck {
  id: string;
  name: string;
  external?: true;
  lastVerify?: LastVerify;
}

export interface LedgerClaim {
  id: string;
  text: string;
  status: ClaimStatus;
  assertedOnly: boolean;
  unverified: number;
  latest?: { content?: string; observed_at?: number; mode?: string; check?: string; checkVersion?: string };
  checks: LedgerCheck[];
}

/** One list per subject: a workflow by name, a step by type. */
export type Ledger = Record<string, LedgerClaim[]>;

export interface ParsedNotice {
  kind: "run" | "verify";
  /** First line, prefix removed. */
  headline: string;
  workflow?: string;
  runId?: string;
  /** `[run-notification]` only. */
  runStatus?: string;
  duration?: string;
  error?: string;
  /** Parsed JSON, or the raw text when truncated / unparseable. */
  output?: unknown;
  outputTruncated?: boolean;
  ledger?: Ledger;
  /** The run finished before its verify pass: a `[verify-notification]` follows. */
  verifying?: boolean;
  /** What the checks cost, as written ("$0.0012"). */
  cost?: string;
  /** Lines addressed to the model (what to do next), and anything unrecognized. */
  notes: string[];
}

const PREFIXES = { "[run-notification]": "run", "[verify-notification]": "verify" } as const;

export function isNotice(text: string): boolean {
  return Object.keys(PREFIXES).some((p) => text.startsWith(p));
}

function parseLedger(json: string): Ledger | undefined {
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    for (const claims of Object.values(v)) {
      if (!Array.isArray(claims) || claims.some((c) => !c || typeof c.text !== "string" || !Array.isArray(c.checks))) return undefined;
    }
    return v as Ledger;
  } catch {
    return undefined;
  }
}

export function parseNotice(text: string): ParsedNotice | null {
  const prefix = (Object.keys(PREFIXES) as (keyof typeof PREFIXES)[]).find((p) => text.startsWith(p));
  if (!prefix) return null;
  const [first = "", ...rest] = text.slice(prefix.length).split("\n");
  const notice: ParsedNotice = { kind: PREFIXES[prefix], headline: first.trim(), notes: [] };

  const ran = /^Workflow "(.+)" run (\S+) finished: (\w+)(?: in (.+?))?\.$/.exec(notice.headline);
  const verified = /^Run (\S+) of "(.+)" was verified against its claims\b/.exec(notice.headline);
  if (ran) Object.assign(notice, { workflow: ran[1], runId: ran[2], runStatus: ran[3], ...(ran[4] ? { duration: ran[4] } : {}) });
  if (verified) Object.assign(notice, { runId: verified[1], workflow: verified[2] });
  const cost = /Checks cost (\$[\d.]+)\./.exec(notice.headline);
  if (cost) notice.cost = cost[1];

  // An error message can span lines: unrecognized lines right after `Error:`
  // belong to it.
  let inError = false;
  for (let i = 0; i < rest.length; i++) {
    const line = rest[i]!;
    if (line.startsWith("claims: ")) {
      const ledger = parseLedger(line.slice("claims: ".length));
      if (ledger) notice.ledger = ledger;
      else notice.notes.push(line);
    } else if (line.startsWith("Output: ")) {
      const json = line.slice("Output: ".length);
      try {
        notice.output = JSON.parse(json);
      } catch {
        notice.output = json;
      }
    } else if (/^Output \(truncated, \d+ chars total\):$/.test(line)) {
      notice.output = rest[++i] ?? "";
      notice.outputTruncated = true;
    } else if (line.startsWith("Error: ")) {
      notice.error = line.slice("Error: ".length);
      inError = true;
      continue;
    } else if (line.startsWith("Verification against its claims is still running")) {
      notice.verifying = true;
    } else if (line.startsWith("Verified against its claims")) {
      // The summary restates the ledger on the next line.
    } else if (inError && !line.startsWith("Full details: ")) {
      notice.error += `\n${line}`;
      continue;
    } else if (line.trim()) {
      notice.notes.push(line);
    }
    inError = false;
  }
  return notice;
}

export interface LedgerCounts {
  total: number;
  supported: number;
  refuted: number;
  unknown: number;
  stale: number;
  assertedOnly: number;
  /** Claims with a check waiting on a person / outside system. */
  waiting: number;
}

export function countLedger(ledger: Ledger): LedgerCounts {
  const claims = Object.values(ledger).flat();
  const n = (s: ClaimStatus) => claims.filter((c) => c.status === s).length;
  return {
    total: claims.length,
    supported: n("supported"),
    refuted: n("refuted"),
    unknown: n("unknown"),
    stale: n("stale"),
    assertedOnly: claims.filter((c) => c.assertedOnly).length,
    waiting: claims.filter((c) => c.checks.some((k) => k.lastVerify && "planned" in k.lastVerify)).length,
  };
}

/** One word for the card's dot: the worst thing a person should know. */
export function noticeTone(n: ParsedNotice): "ok" | "error" | "warning" | "pending" | "neutral" {
  if (n.runStatus === "error") return "error";
  const c = n.ledger ? countLedger(n.ledger) : null;
  if (c?.refuted) return "error";
  if (n.runStatus === "cancelled" || (c && (c.unknown || c.stale || c.waiting))) return "warning";
  if (n.verifying) return "pending";
  if (c || n.runStatus === "success") return "ok";
  return "neutral";
}

/** What a check did on this run, for a person. */
export function lastVerifyLabel(v: LastVerify | undefined): { label: string; tone: "ok" | "warning" | "error" | "dim"; detail?: string } {
  if (!v) return { label: "did not fire", tone: "dim" };
  if ("ran" in v) return { label: "ran", tone: "ok" };
  if ("pending" in v) return { label: "pending", tone: "dim" };
  if ("planned" in v) return { label: "waiting on someone", tone: "warning" };
  return {
    label: `skipped · ${v.skipped}`,
    // A check that cannot launch is broken, not passed.
    tone: v.skipped === "cannot-launch" ? "error" : "dim",
    ...(v.reason ? { detail: v.reason } : {}),
  };
}
