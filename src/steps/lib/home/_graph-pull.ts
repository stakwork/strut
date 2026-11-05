// POST /home/pull on a host whose memory is the graph (`memory: "graph"`).
// The copy keeps a read copy for dictation, so the pull carries dictation's
// vocabulary alone, as dictation/changes-since's changes since the copy's
// last pull, and the copy replays them with dictation/apply-changes. The
// rest of the graph is not pulled: the whole-memory snapshot is the old
// memory database's (memory/export).
//
// The reply keeps the pull's shape: `content_hash` is what the copy holds
// and sends back as `hash`. Here it is a cursor, the box's `until`, so the
// next pull starts where this one ended. A hash that is no cursor (an old
// memory's content_hash, or none) pulls the whole vocabulary, which the copy
// skips as known. Leading underscore: imported by home sync, skipped by
// registry discovery.
import type { StepContext } from "../../../core.js";
import type { ChangeT } from "../dictation/_shared.js";
import { graphChanges } from "../dictation/_graph.js";

/** What a graph pull's content_hash starts with. */
export const GRAPH_PULL = "graph-dictation:";

export type GraphPull = { unchanged: true; content_hash: string } | { content_hash: string; dictation: ChangeT[] };

/** The box's side: dictation's changes since the cursor `hash` names. */
export async function graphPull(ctx: StepContext<unknown>, hash?: string): Promise<GraphPull> {
  const at = hash?.startsWith(GRAPH_PULL) ? Date.parse(hash.slice(GRAPH_PULL.length)) : NaN;
  const { changes, until } = await graphChanges(ctx, Number.isFinite(at) ? at : 0);
  const content_hash = `${GRAPH_PULL}${until}`;
  return changes.length ? { content_hash, dictation: changes } : { unchanged: true, content_hash };
}
