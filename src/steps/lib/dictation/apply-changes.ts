import { z } from "zod";
import { defineStep } from "../../../core.js";
import { entryWriting, wasUndone, type Lexicon } from "../../../audio/lingo.js";
import { memoryDb } from "../memory/_db.js";
import add from "./add.js";
import undo from "./undo.js";
import { Change, readLexicon, type ChangeT } from "./_shared.js";

const same = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** The pair `c` names in this memory: its entity and mishearing, if kept. */
function find(lexicon: Lexicon, c: ChangeT) {
  const entry = entryWriting(lexicon, c.name ?? c.written);
  const heard = entry?.heard.find((h) => same(h.value, c.heard!) && same(h.form ?? entry.name, c.written));
  return entry && heard ? { entry, heard } : undefined;
}

const Applied = z.object({
  op: z.enum(["learn", "undo"]),
  heard: z.string().optional(),
  written: z.string(),
  result: z.enum(["learned", "known", "undone", "already undone", "not found", "not dictation's"]),
});

// Replays another strut's dictation changes (dictation/changes-since there)
// through dictation/add and dictation/undo here, in order. Safe to replay:
// a pair this memory already keeps is "known", one already undone is
// "already undone", and an undo is matched by its pair, since the two graphs
// give it different ids.
export default defineStep({
  type: "dictation/apply-changes",
  description:
    "Replays dictation changes from another strut (dictation/changes-since there) into this memory, in order: a learn " +
    "through dictation/add, an undo of the same heard/written pair through dictation/undo. Idempotent: a pair already known " +
    "or already undone is skipped, so the same changes can be sent again. Reports what each did.",
  effect: "write",
  input: z.object({ changes: z.array(Change).default([]) }),
  output: z.object({ applied: z.array(Applied) }),
  async run(cfg, ctx) {
    const applied: Array<z.infer<typeof Applied>> = [];
    const done = (c: ChangeT, result: z.infer<typeof Applied>["result"]) =>
      applied.push({ op: c.op, ...(c.heard !== undefined ? { heard: c.heard } : {}), written: c.written, result });
    // Read again only after a change that wrote: a replay is mostly "known".
    let lexicon: Lexicon | undefined;
    for (const c of cfg.changes) {
      const current: Lexicon = (lexicon ??= await readLexicon(ctx));
      if (!c.term && !c.heard) throw new Error(`dictation/apply-changes: a ${c.op} of "${c.written}" needs heard, or term`);
      if (c.op === "learn") {
        if (c.term ? entryWriting(current, c.written) : find(current, c)) {
          done(c, "known");
          continue;
        }
        const out = await add.run(add.input.parse({ heard: c.heard ?? c.written, written: c.written, ...(c.name ? { name: c.name } : {}), ...(c.term ? { term: true } : {}) }), ctx);
        if (out.undo.length) lexicon = undefined;
        done(c, out.undo.length ? "learned" : "known");
        continue;
      }
      // An undo forgets what the learn made: the entity, when dictation made it
      // and this pair is all that is known of it; else the mishearing alone.
      let id: string | undefined;
      if (c.term) {
        const word = current.entries.find((e) => e.type === current.lingoType && same(e.name, c.written) && e.facts === 0);
        id = word?.refId;
        if (!id) {
          done(c, (await termUndone(ctx, current, c.written)) ? "already undone" : "not found");
          continue;
        }
      } else {
        const hit = find(current, c);
        if (!hit) {
          done(c, wasUndone(current, c.heard!, c.written) ? "already undone" : "not found");
          continue;
        }
        const [made] = await (await memoryDb(ctx))("MATCH (e:Entity) WHERE e.ref_id = $id RETURN e.created_by AS by", { id: hit.entry.refId });
        id = made?.["by"] === "dictation" && hit.entry.heard.length === 1 && hit.entry.facts <= 1 ? hit.entry.refId : hit.heard.refId;
      }
      try {
        await undo.run({ undo: [id] }, ctx);
        lexicon = undefined;
        done(c, "undone");
      } catch (err) {
        if (!/not written by dictation/.test(err instanceof Error ? err.message : String(err))) throw err;
        done(c, "not dictation's");
      }
    }
    return { applied };
  },
});

/** Whether a term `written` was undone here already. */
async function termUndone(ctx: Parameters<typeof memoryDb>[0], lexicon: Lexicon, written: string): Promise<boolean> {
  if (!lexicon.lingoType) return false;
  const rows = await (await memoryDb(ctx))(
    "MATCH (e:Entity) WHERE e.type = $t AND lower(e.name) = $n AND e.deleted_reason = 'undone' RETURN e.ref_id AS id LIMIT 1",
    { t: lexicon.lingoType, n: written.toLowerCase() },
  );
  return rows.length > 0;
}
