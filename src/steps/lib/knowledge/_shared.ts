import { workflowOf, type StepContext } from "../../../core.js";
import type { GraphBackend } from "../../../graph/backend.js";
import type { Proposal } from "../../../proposals.js";
import { boundsOf, graphFor, readsNamespace } from "../../../graph/scope.js";
import type { KnowledgeCapability } from "../../../knowledge.js";

/**
 * The `knowledge/*` steps are the Knowledge door as registry steps
 * (src/knowledge.ts): what a workflow that tends the Concept tree is granted,
 * and no workflow of ordinary work is. Thin over `ctx.services.knowledge`,
 * which the standard server sets wherever the claims layer is on.
 *
 * The capability reads the graph as it is, past any reader's list
 * (`graph/scope.ts`). So each step asks first whether ITS CALLER may read
 * the namespace the tree is kept in, the graph's own, and shows nothing the
 * caller's typed reads would not: on a personal strut an app's page reads
 * `shared` alone, and is refused here.
 */
export function requireKnowledge(ctx: StepContext | undefined, step: string): KnowledgeCapability {
  const services = ctx?.services as { knowledge?: KnowledgeCapability } | undefined;
  if (!services?.knowledge) throw new Error(`${step} needs the claims layer (ctx.services.knowledge): a graph-backed workspace with claims on`);
  requireTree(ctx, step);
  return services.knowledge;
}

/** Refused unless the caller may read the graph's own namespace, where the
 *  Concept tree is kept (above). */
export function requireTree(ctx: StepContext | undefined, step: string): void {
  const services = ctx?.services as { graph?: GraphBackend } | undefined;
  if (services?.graph) {
    const view = graphFor(services.graph, ctx);
    const bounds = boundsOf(view);
    if (bounds && !readsNamespace(bounds.list, view.namespace, view.namespace)) {
      throw new Error(`${step}: this caller may not read "${view.namespace}", where the Concept tree is kept${ctx?.app ? " (an app's page reads only what an app may)" : ""}`);
    }
  }
}

/** Who a proposal a step makes is by: the run (or, applying an accepted
 *  proposal, the run that proposed that one). Never a branch: what these
 *  steps propose is main's. */
export function proposerOf(ctx: StepContext): Proposal["by"] {
  if (ctx.proposal) return { workflow: ctx.proposal.by.workflow, runId: ctx.proposal.by.runId, path: ctx.path, ...(ctx.actor ? { actor: ctx.actor } : {}) };
  return {
    workflow: workflowOf(ctx),
    runId: ctx.runId,
    path: ctx.path,
    ...(ctx.job ? { job: ctx.job } : {}),
    ...(ctx.actor ? { actor: ctx.actor } : {}),
    ...(ctx.principal ? { principal: ctx.principal } : {}),
  };
}
