/** The ledger (plans/claims.md §5): what a tool result says about a contract. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Flow } from "./core.js";
import type { SubjectLedgerRow, SubjectRef } from "./graph/claims.js";
import { VERIFY_NOTIFICATION_PREFIX, buildLedger, formatLedgerLines, formatVerifyNotification, ledgerIsEmpty, subjectsOfFlow } from "./ledger.js";
import type { VerifiedCheck } from "./verify.js";

const STEP: SubjectRef = { kind: "step", type: "clip/compute-times" };
const WF: SubjectRef = { kind: "workflow", name: "youtube-clip" };

const row = (id: string, text: string, status: SubjectLedgerRow["status"]["status"], checks: Array<Partial<SubjectLedgerRow["checks"][number]> & { id: string }>, over: Partial<SubjectLedgerRow["status"]> = {}): SubjectLedgerRow => ({
  claim: { ref_id: `ref-${id}`, id, name: text, claim_text: text },
  checks: checks.map((k) => ({ ref_id: `ref-${k.id}`, name: k.id, created_at: 1, ...k })),
  status: { status, assertedOnly: false, unverified: 0, openSlot: false, slots: [], ...over },
});

const reader = (bySubject: Record<string, SubjectLedgerRow[]>) => ({
  statusFor: async (s: SubjectRef) => bySubject[s.kind === "step" ? s.type : s.name] ?? [],
});

describe("buildLedger", () => {
  const rows = {
    "clip/compute-times": [
      row("c1", "end is after start", "refuted", [{ id: "k1", step_type: "exec" }, { id: "k2", step_type: "llm" }], {
        unverified: 1,
        latest: { ref_id: "e", id: "e1", name: "n", claim_id: "c1", content: "end 40 <= start 50", observed_at: 99, evidence_mode: "observed", check_id: "k1", source: { ref_id: "r", context: { checkVersion: "exec" } } },
      }),
      row("c2", "the cut sounds natural", "unknown", [{ id: "kx", description: "listen" }], { openSlot: true, slots: [{ evidence_id: "slot-1", check_id: "kx" }] }),
    ],
    "youtube-clip": [row("c3", "the clip contains the quote", "supported", [{ id: "k3", step_type: "subflow", run_when: "publish" }], { assertedOnly: true })],
  };

  it("one list per subject that has claims; status, latest, and each check's lastVerify from the pass", async () => {
    const checks: VerifiedCheck[] = [
      // a foreach: three outcomes for one check read as the most informative one
      { subject: STEP, path: "wf/each#0", claimId: "c1", checkId: "k1", lastVerify: { skipped: "cannot-launch", reason: "x" } },
      { subject: STEP, path: "wf/each#1", claimId: "c1", checkId: "k1", lastVerify: { ran: true } },
      { subject: STEP, path: "wf/each#0", claimId: "c1", checkId: "k2", lastVerify: { skipped: "budget" } },
      // the same check id on ANOTHER subject must not leak in
      { subject: { kind: "step", type: "other" }, path: "p", claimId: "c1", checkId: "k2", lastVerify: { ran: true } },
    ];
    const ledger = await buildLedger(reader(rows), [WF, STEP, { kind: "step", type: "log" }], { result: { checks } });
    assert.deepEqual(Object.keys(ledger), ["youtube-clip", "clip/compute-times"], "a subject with no claims is left out");
    assert.deepEqual(ledger["clip/compute-times"], [
      {
        id: "c1", text: "end is after start", status: "refuted", assertedOnly: false, unverified: 1,
        latest: { content: "end 40 <= start 50", observed_at: 99, mode: "observed", check: "k1", checkVersion: "exec" },
        checks: [{ id: "k1", name: "k1", lastVerify: { ran: true } }, { id: "k2", name: "k2", lastVerify: { skipped: "budget" } }],
      },
      {
        id: "c2", text: "the cut sounds natural", status: "unknown", assertedOnly: false, unverified: 0,
        checks: [{ id: "kx", name: "kx", external: true, lastVerify: { planned: "slot-1" } }],
      },
    ]);
    assert.deepEqual(ledger["youtube-clip"]![0]!.checks, [{ id: "k3", name: "k3" }], "no outcome this pass, no slot → no lastVerify");
  });

  it("at launch every RUN check is pending — a publish check has no verdict coming from a run", async () => {
    const ledger = await buildLedger(reader(rows), [STEP, WF], { pending: true });
    assert.deepEqual(ledger["clip/compute-times"]!.map((c) => c.checks.map((k) => k.lastVerify)), [[{ pending: true }, { pending: true }], [{ planned: "slot-1" }]]);
    assert.deepEqual(ledger["youtube-clip"]![0]!.checks[0]!.lastVerify, undefined);
    assert.ok(ledgerIsEmpty(await buildLedger(reader({}), [STEP])));
  });

  it("a workflow and a step that share a name stay apart", async () => {
    const same = { twin: [row("c9", "t", "unknown", [{ id: "k9" }])] };
    const ledger = await buildLedger(reader(same), [{ kind: "workflow", name: "twin" }, { kind: "step", type: "twin" }]);
    assert.deepEqual(Object.keys(ledger), ["twin", "step:twin"]);
  });
});

describe("subjectsOfFlow / notifications", () => {
  it("what a launch can execute: the workflow, its nested children, and every step type in reach", async () => {
    const child: Flow = { name: "stt-check", input: z.any(), steps: [{ id: "t", type: "stt/transcribe", config: {} }] };
    const flow: Flow = {
      name: "youtube-clip",
      input: z.any(),
      steps: [
        { id: "a", type: "clip/fetch", config: {} },
        { id: "b", type: "subflow", config: { workflow: "stt-check", input: {} } },
        { id: "c", type: "clip/fetch", config: {} },
      ],
    };
    const ws = { getWorkflow: async () => child, getWorkflowVersion: async () => child };
    assert.deepEqual(await subjectsOfFlow(flow, ws, "youtube-clip"), [
      { kind: "workflow", name: "youtube-clip" },
      { kind: "workflow", name: "stt-check" },
      { kind: "step", type: "clip/fetch" },
      { kind: "step", type: "subflow" },
      { kind: "step", type: "stt/transcribe" },
    ]);
  });

  it("the [verify-notification] leads with what needs attention, then carries the ledger as JSON", async () => {
    const ledger = await buildLedger(
      reader({
        "clip/compute-times": [
          row("c1", "a", "refuted", [{ id: "k1" }]),
          row("c2", "b", "supported", [{ id: "k2" }], { assertedOnly: true }),
          row("c3", "c", "unknown", [{ id: "kx" }], { slots: [{ evidence_id: "s1", check_id: "kx" }] }),
        ],
      }),
      [STEP],
    );
    const text = formatVerifyNotification({ workflow: "youtube-clip", runId: "1789", ledger, costUsd: 0.0123 });
    assert.ok(text.startsWith(`${VERIFY_NOTIFICATION_PREFIX} Run 1789 of "youtube-clip" was verified against its claims — clip/compute-times: 1 REFUTED, 1 supported, 1 unknown (1 asserted-only) (1 waiting on an external check). Checks cost $0.0123.`), text);
    assert.deepEqual(JSON.parse(text.split("\n")[1]!.replace(/^claims: /, "")), ledger);
    assert.match(text, /not done/);
    assert.ok(!formatVerifyNotification({ workflow: "w", runId: "1", ledger }).includes("cost"));
    assert.match(formatLedgerLines(ledger), /^Verified against its claims — .*\nclaims: \{/);
  });
});
