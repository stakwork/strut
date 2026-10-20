import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { PeersCapability } from "../../../peers.js";

/**
 * The peers this strut may call (plans/federation.md §3), as an agent reads
 * them before `strut/run-workflow`: each one's id, and what the host said it
 * holds — a label, a description, its repositories — so "the sphinx-apps
 * workspace" or "the mixer's code" leads to the right id instead of a guess.
 * Never a token or a base URL: neither helps the model choose.
 */
export default defineStep({
  type: "strut/list-peers",
  description:
    "List the OTHER struts this one can call with strut/run-workflow: { peers: [{ id, label?, description?, repos? }] }. " +
    "`id` is what strut/run-workflow's `peer` takes (hive registers a workspace by its slug, what a person types as @<slug>); " +
    "`repos` are the repositories that workspace holds, so code that is not here can be found there.",
  input: z.object({}),
  output: z.object({
    peers: z.array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        description: z.string().optional(),
        repos: z.array(z.string()).optional(),
      }),
    ),
  }),
  async run(_cfg, ctx: StepContext<StrutCapabilities & { peers?: PeersCapability }>) {
    const peers = ctx.services?.peers;
    if (!peers) {
      throw new Error(
        "strut/list-peers needs the peers capability (ctx.services.peers) — the standard strut server provides it; a bare runWorkflow bag does not",
      );
    }
    return {
      peers: (await peers.list()).map(({ id, label, description, repos }) => ({
        id,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(repos?.length ? { repos } : {}),
      })),
    };
  },
});
