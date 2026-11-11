import type { StepContext } from "../../../core.js";
import type { KnowledgeCapability } from "../../../knowledge.js";

/**
 * The `knowledge/*` steps are the Knowledge door as registry steps
 * (src/knowledge.ts): what a workflow that tends the Concept tree is granted,
 * and no workflow of ordinary work is. Thin over `ctx.services.knowledge`,
 * which the standard server sets wherever the claims layer is on.
 */
export function requireKnowledge(ctx: StepContext | undefined, step: string): KnowledgeCapability {
  const k = (ctx?.services as { knowledge?: KnowledgeCapability } | undefined)?.knowledge;
  if (!k) throw new Error(`${step} needs the claims layer (ctx.services.knowledge): a graph-backed workspace with claims on`);
  return k;
}
