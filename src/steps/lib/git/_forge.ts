/**
 * A FORGE'S STEPS, BY HOST (plans/package-seams.md §4): the box's git hosts
 * (`ctx.services.gitHosts`, src/git-hosts.ts) and the steps each names, which
 * `git/repositories` and `git/pull-request` call so a caller names no forge.
 * The input and output each provider step takes and answers are strut's,
 * held here and written on those two steps' descriptions.
 */
import { z } from "zod";
import type { AnyStepDef, StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { STRUT_GIT_HOSTS, type GitHost } from "../../../git-hosts.js";

/** One repository a token reaches, as a `repositories` step answers it. */
export const forgeRepository = z.object({
  url: z.string().min(1),
  name: z.string().min(1),
  private: z.boolean().optional(),
  /** When it was last pushed to, ISO 8601. */
  pushed: z.string().optional(),
  description: z.string().optional(),
});

/** What a `repositories` step answers for `{ host }`. */
export const repositoriesOutput = z.object({ repositories: z.array(forgeRepository) });

/** What a `pull_request` step answers for `{ url, head, base, title, body }`:
 *  the pull request's page, its number and whether this call opened it. */
export const pullRequestOutput = z
  .object({ url: z.string().min(1), number: z.number().optional(), created: z.boolean().optional() })
  .passthrough();

/** The box's hosts, strut's own entry when the bag keeps none. */
export const boxHostsOf = (ctx: StepContext<StrutCapabilities> | undefined): readonly GitHost[] => ctx?.services?.gitHosts?.hosts() ?? STRUT_GIT_HOSTS;

/** Run the provider step `type` with this step's ctx — as the run's person,
 *  behind the provider's own fence — on `input`. */
export async function callForgeStep(ctx: StepContext<StrutCapabilities> | undefined, type: string, input: unknown): Promise<unknown> {
  const def = ctx?.registry?.[type] as AnyStepDef | undefined;
  if (!def) throw new Error(`forge_step_missing: the step ${type} is not on this strut server`);
  return def.run(def.input.parse(input), ctx as StepContext<unknown>);
}
