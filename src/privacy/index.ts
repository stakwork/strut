import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyStage, detectAll, ruleStage, type Stage } from "./detect.js";
import type { KeyCtx, KeyProvider } from "./keys.js";
import { llmStage, workerLlm } from "./llm.js";
import { nerStage, workerNer } from "./ner.js";
import { pseudonymize } from "./pseudonymize.js";
import { restore } from "./restore.js";
import { destroyVault, getVault, kindOf, putVault, type VaultDeps } from "./vault.js";
import type { LlmEngine, NerEngine, VaultKind, Warning } from "./types.js";

export * from "./types.js";
export { detectAll, resolve, typeFix, ruleSpans, denySpans, denyStage, ruleStage, type Stage, type DetectOpts } from "./detect.js";
export { pseudonymize } from "./pseudonymize.js";
export { restore } from "./restore.js";
export { putVault, getVault, destroyVault, kindOf, HANDLE_RE, type VaultDeps } from "./vault.js";
export { secretKeyProvider, VAULT_KEY_SECRET, type KeyProvider, type KeyCtx } from "./keys.js";
export { transformersNer, workerNer, nerStage, nerPostprocess, groupAndAlign } from "./ner.js";
export { transformersLlm, workerLlm, llmStage, llmPostprocess, parseLlmReply } from "./llm.js";
export { PRIVACY_MODELS, NER_MODEL, LLM_MODEL, privacyModelOptions, type PrivacyModelOptions } from "./models.js";

/** `ctx.services.privacy`: the injection seam (tests, a host with its own key provider or models). */
export interface PrivacyServices {
  ner?: NerEngine;
  llm?: LlmEngine;
  keys?: KeyProvider;
  /** Where file vaults live; default `<dataDir>/privacy/vault`. */
  vaultDir?: string;
}

export interface AnonymizeOptions {
  vault: VaultKind;
  ttlMinutes: number;
  deny: string[];
  allow: string[];
  ner: boolean;
  llm: boolean;
  minScore: number;
  privacyLevel: "off" | "basic" | "strict";
}

export interface AnonymizeResult {
  text: string;
  handle: string;
  counts: Record<string, number>;
  entities: number;
  warnings: Warning[];
  detector: { rules: true; gazetteer: true; ner: boolean; llm: boolean };
  vault: VaultKind;
}

export function depsFrom(ctx: KeyCtx): { vault: VaultDeps; services: PrivacyServices } {
  const s = (ctx.services ?? {}) as { dataDir?: string; privacy?: PrivacyServices };
  const priv = s.privacy ?? {};
  return {
    vault: { dir: priv.vaultDir ?? join(s.dataDir ?? join(tmpdir(), "strut"), "privacy", "vault"), ...(priv.keys ? { keys: priv.keys } : {}) },
    services: priv,
  };
}

function mergeWarnings(ws: Warning[]): Warning[] {
  const by = new Map<string, Warning>();
  for (const w of ws) {
    const have = by.get(w.code);
    if (have) have.count = (have.count ?? 0) + (w.count ?? 0);
    else by.set(w.code, { ...w });
  }
  return [...by.values()];
}

/** Anonymize each text with its own vault entry (one handle per text). NER is fail-closed. */
export async function anonymizeTexts(texts: string[], o: AnonymizeOptions, ctx: KeyCtx): Promise<AnonymizeResult[]> {
  const { vault, services } = depsFrom(ctx);
  const stages: Stage[] = [denyStage, ruleStage];
  if (o.ner) {
    const engine = services.ner ?? workerNer();
    stages.push(nerStage({
      async detect(t) {
        try { return await engine.detect(t); }
        catch (e) { throw new Error(`ner_unavailable: the NER model could not be used, refusing to continue without it (${(e as Error).message})`); }
      },
    }));
  }
  if (o.llm) stages.push(llmStage(services.llm ?? workerLlm()));

  const out: AnonymizeResult[] = [];
  for (const text of texts) {
    const warnings: Warning[] = [];
    if (o.privacyLevel !== "off") warnings.push({ code: "privacy_level_not_implemented", message: `privacy_level "${o.privacyLevel}" is reserved; behaving as "off"` });
    const spans = await detectAll(text, stages, { deny: o.deny, minScore: o.minScore, warn: (w) => warnings.push(w) });
    const { out: masked, map, counts } = pseudonymize(text, spans, { allow: o.allow });
    const handle = await putVault(o.vault, map, o.ttlMinutes, ctx, vault);
    out.push({
      text: masked,
      handle,
      counts,
      entities: Object.values(counts).reduce((a, b) => a + b, 0),
      warnings: mergeWarnings(warnings),
      detector: { rules: true, gazetteer: true, ner: o.ner, llm: o.llm },
      vault: o.vault,
    });
  }
  return out;
}

export async function deanonymizeText(text: string, handle: string, destroy: boolean | undefined, ctx: KeyCtx) {
  const { vault } = depsFrom(ctx);
  const map = await getVault(handle, ctx, vault);
  if (!map) throw new Error("vault_not_found: the handle is unknown or expired");
  const r = restore(text, map);
  const doDestroy = destroy ?? kindOf(handle) === "memory";
  if (doDestroy) await destroyVault(handle, vault);
  return { text: r.text, restored: r.restored, unknown_pseudonyms: r.unknown, destroyed: doDestroy };
}

export async function destroyHandle(handle: string, ctx: KeyCtx): Promise<boolean> {
  return destroyVault(handle, depsFrom(ctx).vault);
}
