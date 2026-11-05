import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { listModelOptions } from "../../../llm.js";

/**
 * The models this strut can call (plans/jamie-app.md §5): the list `GET
 * /llm/models` serves — every model aieo knows, each `available` when the
 * host lists it (`STRUT_MODELS`) or, with no list, when its provider has a
 * key here (the secret store, then env), never a key's value — as a step,
 * for a page that cannot fetch a route: strut's own assistant app's model
 * picker. A model chosen from it is what an `agent` or `llm` step's `model`
 * (or a workflow's `params.model`) takes.
 */
export default defineStep({
  type: "llm/models",
  effect: "read",
  description:
    "The models this strut server can call, as GET /llm/models lists them: { default, models: [{ name, provider, modelId, alias?, default, available, contextLimit?, pricing? }], keyNames }. " +
    "`name` is the canonical `provider/id` an agent's or a workflow's `model` takes; `available` says whether people may pick it: the deployment's list (STRUT_MODELS) when it has one, else whether the provider has a key configured here (never the key). " +
    "`contextLimit` is the window in tokens; `pricing` is USD per million tokens, only where the model's own rate is known. `default` is the deployment's default chat model.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx: StepContext<StrutCapabilities>) {
    const services = ctx.services as Partial<StrutCapabilities> | undefined;
    if (services?.llmModels) return services.llmModels();
    return listModelOptions(services?.secrets ? { secrets: services.secrets } : {});
  },
});
