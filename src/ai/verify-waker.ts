/**
 * Wakes a chat with the verdict on a run it launched (`plans/claims.md` §5).
 *
 * The verify pass is detached, so its result reaches the builder the same
 * way a long run's does — as a user-role message that starts its next turn:
 *
 *   - a `[verify-notification]` when the pass settles; or
 *   - folded into the run's own `[run-notification]` when the pass settles
 *     within a short grace window (free checks take well under a second),
 *     so ONE wake-up turn carries the run and the ledger. Machine-triggered
 *     turns are capped (`autoTurns`); spending two per run would park a
 *     build loop twice as fast.
 *
 * Exactly one of the two carries the ledger: whoever takes the run's entry
 * out of the watch map delivers it. Queue-and-drain is the notifier's — a
 * pass that settles while a turn is live lands in that turn's wake-up.
 * Runs nobody watches (launched from the API or UI) just get their evidence
 * written; the panel shows it.
 */
import { formatLedgerLines, formatVerifyNotification, ledgerIsEmpty } from "../ledger.js";
import type { Verifier, VerifyResult } from "../verify.js";

export interface VerifyWaker {
  /** Chat `chatId` launched run `runId` and wants its verdict. */
  watch(runId: string, chatId: string): void;
  /** The verifier's `onSettled`: a detached pass finished. */
  settled(result: VerifyResult): Promise<void>;
  /** Lines to append to a `[run-notification]` for this run: the ledger when
   *  the pass settles inside the grace window, a "still running" note when
   *  it does not, nothing when there is no contract (or nobody is watching). */
  ledgerLinesFor(workflow: string, runId: string): Promise<string>;
}

export const STILL_VERIFYING = "Verification against its claims is still running — a [verify-notification] follows.";

export function createVerifyWaker(opts: {
  verifier: Pick<Verifier, "verifyRun" | "ledger">;
  deliver: (chatId: string, text: string) => Promise<void>;
  graceMs?: number;
}): VerifyWaker {
  const watchers = new Map<string, string>();
  const graceMs = opts.graceMs ?? 5_000;
  const hasContract = (r: VerifyResult) => !r.skipped && r.subjects.length > 0;

  return {
    watch(runId, chatId) {
      watchers.set(runId, chatId);
    },

    async settled(r) {
      const chatId = watchers.get(r.runId);
      if (!chatId) return;
      watchers.delete(r.runId);
      if (!hasContract(r)) return;
      try {
        const ledger = await opts.verifier.ledger(r);
        if (!ledgerIsEmpty(ledger)) await opts.deliver(chatId, formatVerifyNotification({ workflow: r.key, runId: r.runId, ledger, costUsd: r.costUsd }));
      } catch (err) {
        console.error(`[chat ${chatId}] verify-notification delivery failed:`, err);
      }
    },

    async ledgerLinesFor(workflow, runId) {
      if (!watchers.has(runId)) return "";
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          opts.verifier.verifyRun(workflow, runId), // joins the detached pass (single-flight)
          new Promise<null>((res) => {
            timer = setTimeout(() => res(null), graceMs);
          }),
        ]).finally(() => clearTimeout(timer));
        if (!result) return `\n${STILL_VERIFYING}`; // still watched: `settled` will deliver
        if (!watchers.delete(runId)) return ""; // `settled` got there first and delivered
        if (!hasContract(result)) return "";
        const ledger = await opts.verifier.ledger(result);
        return ledgerIsEmpty(ledger) ? "" : `\n${formatLedgerLines(ledger)}`;
      } catch {
        return "";
      }
    },
  };
}
