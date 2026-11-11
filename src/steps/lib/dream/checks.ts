import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CHECK_WORKFLOW, claimChecks, listClaims } from "../../../graph/concept-claims.js";
import { claimGraph } from "./_graph.js";

const DAY = 86_400_000;

/**
 * Which checks a dream runs (plans/dream.md, "Checks"), picked by code: those of the claims that are due or
 * that this dream changed (a group's are its children's), then those whose newest result is as old as the check's
 * `freshness_days` (one never run: as old as the check). Capped: each is a paid run. Nothing here runs one.
 */
export default defineStep({
  type: "dream/checks",
  effect: "read",
  description:
    "The checks a dream is to run: { count, items: [{ claim, title, text, check, prompt, input }], skipped: [{ claim, prompt, skipped }], waiting }. " +
    "First the checks of the claims in `due` and `changes` (a group's are its children's), then those whose newest result is older than the check's freshness (7 days), the oldest first, up to `limit`. " +
    "`input` is what the check workflow takes. A check that is not the dream's own kind is in `skipped`; `waiting` counts those left for a later dream. With `limit` 0 none is picked.",
  input: z.object({
    root: z.string().optional().default("Personal"),
    due: z.array(z.any()).optional().default([]).describe("The claims that are due, as dream/due returned them."),
    changes: z.array(z.any()).optional().default([]).describe("The changes this dream made, as dream/apply returned them."),
    limit: z.number().int().nonnegative().max(50).optional().default(0).describe("Most checks to run in one dream. 0: none."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    if (cfg.limit === 0) return { count: 0, items: [], skipped: [], waiting: 0 };
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/checks: this run may not read "${namespace}"`);
    const all = await listClaims(g, namespace, cfg.root);
    const by = new Map(all.map((c) => [c.id, c]));
    const checks = new Map((await claimChecks(g, all.filter((c) => c.check).map((c) => c.id))).map((k) => [k.id, k]));
    // The claims this dream bears on: a group stands for its children, where the checks are.
    const named = [...cfg.due, ...cfg.changes].map((x: any) => String(x?.claim ?? "")).flatMap((id) => [id, ...(by.get(id)?.children ?? [])]);
    const now = Date.now();
    const first = [...new Set(named)].map((id) => by.get(id)).filter((c) => c?.check);
    const stale = all
      .filter((c) => c.check && !named.includes(c.id))
      .map((c) => ({ c, last: c.check!.at ? Date.parse(c.check!.at) : (checks.get(c.check!.id)?.made ?? now) }))
      .filter(({ c, last }) => now - last >= (checks.get(c.check!.id)?.freshness_days ?? 7) * DAY)
      .sort((a, b) => a.last - b.last)
      .map(({ c }) => c);
    const items: any[] = [];
    const skipped: any[] = [];
    let waiting = 0;
    for (const c of [...first, ...stale]) {
      const k = checks.get(c!.check!.id);
      const input = k?.config["input"];
      if (!k || k.step_type !== "subflow" || k.config["workflow"] !== CHECK_WORKFLOW || !input || typeof input !== "object") {
        skipped.push({ claim: c!.id, prompt: c!.check!.prompt, skipped: `its check does not run the ${CHECK_WORKFLOW} workflow` });
      } else if (items.length >= cfg.limit) waiting++;
      else items.push({ claim: c!.id, title: c!.title, text: c!.text, check: k.id, prompt: c!.check!.prompt, input });
    }
    return { count: items.length, items, skipped, waiting };
  },
});
