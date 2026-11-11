import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { boundsOf } from "../../../graph/scope.js";
import { factRows, temporalEdgeTypes } from "../../../graph/ladybug/temporal.js";
import { graphCtx, mayRead } from "../graph/_shared.js";

/** A clock as the graph keeps it (epoch ms; an older row's in seconds), as a date. */
const iso = (v: unknown): string | undefined => {
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n < 1e11 ? n * 1000 : n).toISOString() : undefined;
};

/**
 * The facts memory holds, as they stand (plans/dream.md): what a reader of a dream's run sees beside the tree of
 * Concepts. A fact is a sentence on an edge with the time it holds for; one that ended is kept, marked. Read-only
 * and bounded: the newest first, cut at `limit`, with how many there are in all.
 */
export default defineStep({
  type: "dream/facts",
  effect: "read",
  description:
    "The facts memory holds, the newest first: { count, facts: [{ ref_id, text, kind, subject, object, since?, until?, ended? }] }. `kind` is the relationship (LIVES_IN), " +
    "`since` and `until` the time the fact holds for, `ended` true for one that no longer does. Only what the caller may read; at most `limit`, `count` says how many there are. " +
    "A graph that keeps no facts lists none.",
  input: z.object({ limit: z.number().int().positive().max(500).optional().default(200).describe("Most facts to list (default 200).") }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      const run = boundsOf(b)?.query ?? b.query.bind(b);
      const home = await b.reader.resolveNamespace(undefined);
      const all: Array<Record<string, unknown>> = [];
      for (const edge of await temporalEdgeTypes(run)) {
        for (const r of await factRows(run, edge, true)) {
          if (!mayRead(b, typeof r["namespace"] === "string" ? r["namespace"] : home)) continue;
          const since = iso(r["valid_at"]), until = iso(r["invalid_at"]);
          all.push({
            ref_id: String(r["ref_id"]), text: String(r["text"]), kind: edge,
            subject: String(r["source_title"] ?? ""), object: String(r["target_title"] ?? ""),
            ...(since ? { since } : {}), ...(until ? { until } : {}), ...(r["expired_at"] != null || until ? { ended: true } : {}),
          });
        }
      }
      const at = (f: Record<string, unknown>) => String(f["until"] ?? f["since"] ?? "");
      all.sort((x, y) => Number(!!x["ended"]) - Number(!!y["ended"]) || at(y).localeCompare(at(x)));
      return { count: all.length, facts: all.slice(0, cfg.limit) };
    } catch {
      // A graph with no temporal edges (not a Ladybug file) keeps no facts.
      return { count: 0, facts: [] };
    }
  },
});
