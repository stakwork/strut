// Shared by the privacy tests: a fake NER, a step context, and the model wrapped the way
// resolveModel wraps it (through the registered wrappers).
import "../register.js";
import { applyModelWrappers } from "../../extensions.js";
import type { StepContext } from "../host.js";
import type { NerEngine } from "../types.js";

/** Every occurrence of each word, labelled as the real model would (PER / ORG / LOC). */
export const fakeNer = (words: Record<string, string>): NerEngine => ({
  async detect(texts) {
    return {
      spans: texts.map((t) =>
        Object.entries(words).flatMap(([w, type]) => {
          const out = []; let i = -1;
          while ((i = t.indexOf(w, i + 1)) >= 0) out.push({ s: i, e: i + w.length, type, score: 0.99 });
          return out;
        }),
      ),
      unaligned: 0,
    };
  },
});

export const FIX = {
  person: "Marguerite Okonkwo",
  first: "Marguerite",
  email: "marguerite.o@example.org",
  phone: "(416) 555-0142",
  street: "221 Maple Street",
  id: "123-45-6789",
  org: "Hartwell Analytics",
  city: "Lisbon",
};
export const REAL_VALUES = [FIX.person, FIX.email, FIX.phone, FIX.street, FIX.id, FIX.org];
export const NER = { [FIX.person]: "PER", [FIX.first]: "PER", [FIX.org]: "ORG", [FIX.city]: "LOC" };

let n = 0;
export const uid = (p = "t") => `${p}-${process.pid}-${Date.now()}-${++n}`;

export function makeCtx(opts: { privacy?: unknown; settings?: Record<string, unknown>; services?: Record<string, unknown>; registry?: any; emit?: (e: any) => any; agentTool?: boolean; path?: string; runId?: string } = {}): StepContext<any> {
  return {
    runId: opts.runId ?? uid("run"),
    path: opts.path ?? "wf/agent",
    scope: {},
    input: {},
    emit: (opts.emit ?? (async () => {})) as any,
    services: { privacy: { ner: fakeNer(NER) }, ...(opts.services ?? {}) },
    settings: { ...(opts.privacy !== undefined ? { privacy: opts.privacy } : {}), ...(opts.settings ?? {}) },
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.agentTool ? { agentTool: true } : {}),
  } as StepContext<any>;
}

/** What `resolveModel` does after building a model. `privacy` is the already normalised setting value, or a short form. */
export async function wrap(model: any, o: { ctx?: StepContext<any>; session?: string; baseUrl?: string; routed?: boolean; provider?: string } = {}) {
  const { normalizePrivacy } = await import("../settings.js");
  const ctx = o.ctx ?? makeCtx({ privacy: "hosted" });
  if (ctx.settings?.["privacy"] !== undefined) ctx.settings = { ...ctx.settings, privacy: normalizePrivacy(ctx.settings["privacy"]) as any };
  return applyModelWrappers(model, {
    provider: o.provider ?? model.provider, modelId: model.modelId, baseUrl: o.baseUrl, routed: o.routed ?? false, ctx, session: o.session,
  });
}
