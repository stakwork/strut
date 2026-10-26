import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { PeersCapability } from "../../../peers.js";
import { memoryExclusive } from "../memory/_db.js";
import { message, openSnapshot } from "../memory/_snapshot.js";
import { importSnapshot } from "../memory/import.js";
import { dictationChanges } from "../dictation/changes-since.js";
import applyChanges from "../dictation/apply-changes.js";
import { readState, writeState } from "./_state.js";

/** One sync at a time per data folder: two at once could load an older pull last. */
const running = new Map<string, Promise<unknown>>();

/** POST `body` to the home and return its JSON, or throw with why not. */
async function post(peers: PeersCapability, peer: string, path: string, body: unknown, what: string): Promise<any> {
  const res = await peers.fetch(peer, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(`home-sync: ${what} (${res.status}${out.error ? `: ${out.error}` : ""})`);
  return out;
}

// Home sync, on the strut that keeps a read copy of its home's memory (a
// Mac's): push what dictation changed here since the last sync, then pull
// the home's memory when it changed and load it in place of this one. One
// step, so neither the changes nor the memory pass through a run's journal:
// the output is a summary. A failure anywhere records nothing, and the next
// run pushes the same changes again (the home replays them idempotently).
// What dictation changes here after the push read its changes is read from
// the old graph inside the memory lock, before the replace, and replayed on
// the new one, so the next push carries it. Both reads are in the writes'
// queue over [since, until), as dictation/changes-since reads.
export default defineStep({
  type: "home/sync",
  description:
    "Syncs this strut's read copy of its home's memory with the home, a peer on file (default \"home\") holding a person " +
    "token: pushes what dictation learned or undid here since the last sync (POST /home/push there), then pulls the " +
    "home's memory when it changed (POST /home/pull) and loads it in place of this one (memory/import replace: backed up, " +
    "put back on failure), keeping what dictation changes meanwhile. Records the sync (home/state) only once all of it " +
    "landed; a failure records nothing, and the next run catches up.",
  effect: "write",
  input: z.object({ peer: z.string().min(1).default("home").describe("The home's peer id.") }),
  output: z.object({
    pushed: z.number().describe("dictation changes sent"),
    pulled: z.boolean().describe("whether the home's memory changed and was loaded"),
    hash: z.string().describe("the content_hash of the copy now held"),
    counts: z.record(z.string(), z.number()).optional(),
    backup: z.string().optional(),
    kept: z.number().describe("dictation changes made here during the sync, replayed onto the new memory"),
  }),
  async run(cfg, ctx: StepContext<{ peers?: PeersCapability }>) {
    const key = (ctx.services as { dataDir?: string } | undefined)?.dataDir ?? "";
    const before = running.get(key) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(() => sync(cfg.peer, ctx));
    running.set(key, mine);
    try {
      return await mine;
    } finally {
      if (running.get(key) === mine) running.delete(key);
    }
  },

});

async function sync(peer: string, ctx: StepContext<{ peers?: PeersCapability }>) {
  const peers = ctx.services?.peers;
  if (!peers) throw new Error("home/sync needs the peers capability (ctx.services.peers)");
  let state = readState(ctx);
  // Changes a sync kept but could not replay yet: replayed first, so this
  // push (their times are now) carries them.
  if (state.pending?.length) {
    await applyChanges.run(applyChanges.input.parse({ changes: state.pending }), ctx);
    const { pending: _done, ...rest } = state;
    writeState(ctx, rest);
    state = rest;
  }
  // A `since` that does not read is the start: everything is pushed again, which the home skips as known.
  const parsed = state.since ? Date.parse(state.since) : 0;
  const since = Number.isFinite(parsed) ? parsed : 0;
  // In the writes' queue, `until` taken there, as dictation/changes-since reads:
  // no write in flight is missed, and every later one stamps `until` or later.
  const { changes, until } = await memoryExclusive(ctx, async ({ read }) => {
    const until = Date.now();
    return { changes: (await dictationChanges(read, since, until)).changes, until };
  });
  await post(peers, peer, "/home/push", { dictation: changes }, "the push did not land; nothing was pulled, nothing is lost");
  const out = await post(peers, peer, "/home/pull", state.hash ? { hash: state.hash } : {}, "the pull did not land; the memory here is as it was");
  if (typeof out.content_hash !== "string") throw new Error("home-sync: the home's pull returned no content_hash");
  const record = () => writeState(ctx, { since: new Date(until).toISOString(), hash: out.content_hash, at: new Date().toISOString() });
  if (out.unchanged) {
    record();
    return { pushed: changes.length, pulled: false, hash: out.content_hash, kept: 0 };
  }
  if (typeof out.data !== "string") throw new Error("home-sync: the home's memory changed and its pull carried no data");
  let snapshot: Awaited<ReturnType<typeof openSnapshot>>;
  try {
    snapshot = await openSnapshot(Buffer.from(out.data, "base64"));
  } catch (err) {
    throw new Error(`home-sync: ${message(err)}`);
  }
  const { late, result } = await memoryExclusive(ctx, async (handle) => {
    const late = (await dictationChanges(handle.read, until, Date.now())).changes;
    // On disk before the graph they are in is replaced: a replay that fails
    // (or a crash) leaves them for the next sync, never nowhere.
    if (late.length) writeState(ctx, { ...state, pending: late });
    const result = await importSnapshot(handle, snapshot, true);
    if ("error" in result && late.length) writeState(ctx, state); // the old graph is back, and has them
    return { late, result };
  });
  if ("error" in result) throw new Error(`home-sync: ${result.error}`);
  if (late.length) await applyChanges.run(applyChanges.input.parse({ changes: late }), ctx);
  record();
  return { pushed: changes.length, pulled: true, hash: out.content_hash, counts: result.counts, ...(result.backup ? { backup: result.backup } : {}), kept: late.length };
}
