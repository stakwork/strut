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
  const key = info.session ?? (ctx.agentTool ? `${ctx.runId}/${ctx.path}` : ctx.runId || `anon/${Math.random().toString(36).slice(2)}`);
  return wrapLanguageModel({ model, middleware: privacyMiddleware({ policy, key, info, ctx, store: await transcriptStoreFor(ctx) }) as any });
});

registerToolWrapper(guardTools);
