import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { recordCheck } from "../../../graph/concept-claims.js";
import { claimGraph, writerOf } from "./_graph.js";

/**
 * Keeps what a dream's checks found (plans/dream.md, "Checks"): each result as evidence on its claim, for it or
 * against it, from the check. A check that gave no verdict (its run failed, or it said it could not tell) writes
 * nothing and is reported as skipped: a check that cannot run is never a pass or a fail.
 */
export default defineStep({
  type: "dream/checked",
  effect: "write",
  description:
    "Write a dream's check results: `items` as dream/checks returned them and `results`, one per item in order, each what the check workflow returned ({ supports, content } or { skipped }). " +
    "Returns { checks: [{ claim, prompt, supports?, content?, skipped? }], pass, total, cost }: `total` counts the checks that gave a verdict and `pass` those that held. " +
    "A result with no verdict writes nothing and carries `skipped`, the reason. It changes no Concept and no claim: only evidence, kept apart from what people said.",
  input: z.object({
    items: z.array(z.any()).optional().default([]).describe("The checks run, as dream/checks returned them."),
    results: z.array(z.any()).optional().default([]).describe("What each returned, in the same order."),
    skipped: z.array(z.any()).optional().default([]).describe("The checks dream/checks could not hand on, reported with the rest."),
    created_by: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const checks: any[] = cfg.skipped.map((s: any) => ({ claim: s.claim, prompt: s.prompt, skipped: String(s.skipped) }));
    if (!cfg.items.length) return { checks, pass: 0, total: 0, cost: 0 };
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/checked: this run may not read "${namespace}"`);
    // Lazy: verify.ts loads the runner, which loads the registry's steps (this one among them).
    const { mapCheckResult } = await import("../../../verify.js");
    const by = writerOf(ctx, cfg.created_by);
    let cost = 0;
    for (const [i, it] of cfg.items.entries()) {
      const r = cfg.results[i] as Record<string, unknown> | undefined;
      const base = { claim: it.claim as string, prompt: it.prompt as string };
      if (typeof r?.["cost"] === "number") cost += r["cost"];
      const said = typeof r?.["skipped"] === "string" && r["skipped"] ? r["skipped"] : undefined;
      // The check contract, read as the verify pass reads it (plans/claims.md §4).
      const mapped = said ? ({ kind: "cannot-run", reason: said } as const) : mapCheckResult("subflow", r ? { status: "success", output: r } : { status: "error", error: { message: "the check did not run" } });
      if (mapped.kind === "cannot-run") {
        checks.push({ ...base, skipped: mapped.reason });
        continue;
      }
      try {
        await recordCheck(g, {
          claim: it.claim, check: it.check, prompt: it.prompt, supports: mapped.supports, content: mapped.content,
          ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}),
        });
        checks.push({ ...base, supports: mapped.supports, content: mapped.content });
      } catch (e) {
        checks.push({ ...base, skipped: e instanceof Error ? e.message : String(e) });
      }
    }
    const ran = checks.filter((c) => typeof c.supports === "boolean");
    return { checks, pass: ran.filter((c) => c.supports).length, total: ran.length, cost };
  },
});
