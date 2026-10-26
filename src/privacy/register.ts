import { registerModelWrapper, registerSetting, registerToolWrapper, type ModelCallInfo, type StepContext } from "./host.js";
import { isLocalModel } from "./local-model.js";
import { readPolicy, normalizePrivacy, privacySchema } from "./settings.js";
import { transcriptStoreFor } from "./stores.js";
import { guardTools } from "./tool-guard.js";

// Importing this file turns the feature on: it registers the `privacy` setting, the model wrapper
// and the tool guard with the core's extension points (src/extensions.ts). Off until a setting says so.

registerSetting({ key: "privacy", schema: privacySchema, normalize: normalizePrivacy });

registerModelWrapper(async (model: any, info: ModelCallInfo) => {
  const policy = readPolicy(info.ctx?.settings?.["privacy"]);
  if (!policy || isLocalModel(info)) return model;
  const { wrapLanguageModel } = await import("ai"); // lazy, like every SDK in the engine
  const { privacyMiddleware } = await import("./middleware.js");
  const ctx = info.ctx as StepContext;
  // One transcript per agent session, else per step: two steps of a run never share a token map
  // (in parallel they would each extend their own copy, and the last save would win).
  const key = info.session ?? (ctx.runId ? `${ctx.runId}/${ctx.path}` : `anon/${Math.random().toString(36).slice(2)}`);
  const store = await transcriptStoreFor(ctx);
  // A step's transcript is no use once its run is over; a session's goes on to the next turn.
  if (!info.session) ctx.onRunEnd?.(() => store.drop(key));
  return wrapLanguageModel({ model, middleware: privacyMiddleware({ policy, key, info, ctx, store }) as any });
});

registerToolWrapper(guardTools);
