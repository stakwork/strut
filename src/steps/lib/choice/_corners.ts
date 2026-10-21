import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, writeEdge, type GraphBackend } from "../graph/_shared.js";
import { CORNERS, CORNER_NODE, type Corner } from "./_fgc.js";

export async function backendOf(ctx: unknown): Promise<GraphBackend> {
  return graphCtx(ctx as StepContext<StrutCapabilities>);
}

/** The workspace's Fast/Good/Cheap singletons: found by node_key (fast_id='fast',
 *  …), created when missing. Idempotent; the create is the only write. */
export async function ensureCorners(
  b: GraphBackend,
  namespace: string | undefined,
  corners: readonly Corner[] = CORNERS,
): Promise<{ refs: Partial<Record<Corner, string>>; created: Corner[] }> {
  const refs: Partial<Record<Corner, string>> = {};
  const created: Corner[] = [];
  for (const c of corners) {
    const n = CORNER_NODE[c];
    const found = await b.reader.getNodeByKey(n.type, n.key, namespace);
    if (found?.ref_id) {
      refs[c] = found.ref_id;
      continue;
    }
    const w = await b.nodes.write({ type: n.type, data: { [n.idProp]: n.id, name: n.type } }, "create", namespace ? { namespace } : {});
    refs[c] = w.ref_id;
    created.push(c);
  }
  return { refs, created };
}

export { writeEdge };
