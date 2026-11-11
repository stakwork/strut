import { createHash } from "node:crypto";
import { withUsage, type StepContext } from "../../../core.js";
import { emptyUsage } from "../../../pricing.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { RemoteCapability } from "../../../remote.js";

/** The sentence every remote step's description ends with: what it spends
 *  and who buys (plans/paid-runs.md decision 16). */
export const SPENDS_HELD_CREDIT =
  "It spends the credit this strut server already holds at that seller (an L402 token it keeps, never shown to you) and never pays: " +
  "with none, or too little, it fails saying what the seller asks — then an admin buys credit there with remote/buy-credit, a proposal they accept.";

/** The remote capability, or the error a bare bag gets. */
export function remoteOf(ctx: StepContext<StrutCapabilities> | undefined, step: string): RemoteCapability {
  const remote = ctx?.services?.remote;
  if (!remote) throw new Error(`${step} needs strut's remote door (ctx.services.remote); the standard strut server provides it.`);
  return remote;
}

/** A launch key this step's retries and resumes repeat (the seller
 *  dedupes a key while its run is in flight): the run and the step's path. */
export function launchKeyOf(ctx: Pick<StepContext, "runId" | "path">): string {
  return `strut-${createHash("sha256").update(`${ctx.runId}\n${ctx.path}`).digest("hex").slice(0, 40)}`;
}

/** A remote step's output marked with what the seller CHARGED, in dollars:
 *  the run's totals, a public run's markup and its daily cap all count it
 *  as this run's cost (src/core.ts `withUsage`). No model call of its own. */
export function withCharge<T extends object>(output: T, chargedUsd: unknown): T {
  return typeof chargedUsd === "number" && chargedUsd > 0 ? withUsage(output, { modelCalls: 0, usage: emptyUsage(), cost: chargedUsd }) : output;
}
