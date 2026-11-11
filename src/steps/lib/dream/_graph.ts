/**
 * The graph the `dream/*` steps keep claims on (`src/graph/concept-claims.ts`): the caller's backend, the
 * namespace claims go in, and whether the caller's reader list reads it. The store's queries are not gated by
 * the list (a system workflow's list hides strut's own records, the runs among them), so every step asks
 * `readable` first and shows nothing its caller's typed reads would not.
 */
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import type { ClaimGraph } from "../../../graph/concept-claims.js";
import { boundsOf } from "../../../graph/scope.js";
import { isSystemWorkflow, SYSTEM_WRITER } from "../../../system-workflows.js";
import { graphCtx, mayRead } from "../graph/_shared.js";

export async function claimGraph(ctx: StepContext | undefined): Promise<{ g: ClaimGraph; namespace: string; readable: boolean }> {
  const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
  const namespace = await b.reader.resolveNamespace(undefined);
  const query = boundsOf(b)?.query ?? b.query.bind(b);
  return { g: { dialect: b.dialect, nodes: b.nodes, edges: b.edges, query }, namespace, readable: mayRead(b, namespace) };
}

/** Who a `dream/*` write is recorded as: the name given, else "janitor" inside a workflow strut ships (as an
 *  agent's tools are stamped, `steps/core/agent.ts` `writerOf`), else the run's actor. */
export function writerOf(ctx: StepContext | undefined, given?: string): string | undefined {
  if (given) return given;
  const workflow = ctx?.workflow ?? ctx?.path?.split("/")[0];
  return workflow && isSystemWorkflow(workflow) ? SYSTEM_WRITER : ctx?.actor;
}
