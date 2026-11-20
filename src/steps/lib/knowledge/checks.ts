import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { requireTrials } from "./_shared.js";

export default defineStep({
  type: "knowledge/checks",
  effect: "read",
  description:
    "One Concept's CHECKS and TESTS (plans/claim-trials.md), by its exact name: { concept, ref_id, version, docs, fromGit?, checks, tests, running }. " +
    "`checks`: each claim on the page with the cases that test it and its verdicts on the page's wording now — [{ id, text, speaker?, cases: [{ workflow, input }], samples: [{ run, workflow?, supports, content?, at?, case?, trial? }] }]. " +
    "`tests`: each change tried against the page, newest first — { id, at, page: { version, docs, samples }, change: { version, docs, samples }, live }: two wordings, each with every claim's verdicts on it (`samples`, by claim id); `live` when one of the two is the page now. " +
    "`running`: the samples started and not yet judged — [{ id, test?, claim?, total, done, errors }]; `problem`: what the last run left with no verdict, in a line. `docs` is the page's whole text; `fromGit` says the page's text comes from git and whether a change to it can be written here. " +
    "A string when there is no Concept of that name.",
  input: z.object({ concept: z.string().describe('The Concept\'s exact name, e.g. "Orchestrator".') }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    return (await requireTrials(ctx, "knowledge/checks").checks(cfg.concept)) ?? `no Concept named "${cfg.concept}": names are exact`;
  },
});
