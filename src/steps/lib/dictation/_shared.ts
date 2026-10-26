// What the dictation/* steps share: reading the vocabulary and writing one
// mishearing. Leading underscore: imported by siblings, skipped by registry
// discovery. A client only sends what it saw; every judgement is strut's.
import { z } from "zod";
import type { StepContext } from "../../../core.js";
import { learnInput, lexiconFrom, undoIds, type Lexicon } from "../../../audio/lingo.js";
import lexiconStep from "../memory/lexicon.js";
import remember from "../memory/remember.js";

export { UNDONE } from "../memory/lexicon.js";

/** Dictation's vocabulary as memory/lexicon reads it now. */
export async function readLexicon(ctx: StepContext<unknown>): Promise<Lexicon> {
  return lexiconFrom(await lexiconStep.run({}, ctx));
}

export const Learned = z.object({
  heard: z.string(),
  written: z.string(),
  undo: z.array(z.string()).describe("What dictation/undo takes back: the new entity, else the new fact; empty when memory already had it."),
});
export type LearnedT = z.infer<typeof Learned>;

/** Writes that dictation writes `heard` for `written`: the pair alone, on the
 *  entity that writes it or a new word; with `term`, the new word alone; with
 *  `name`, on the person of that full name (made when nothing writes it). */
export async function learn(heard: string, written: string, lexicon: Lexicon, ctx: StepContext<unknown>, term = false, name?: string): Promise<LearnedT> {
  const input = learnInput(heard, written, lexicon, term, name);
  if (!input) return { heard, written, undo: [] };
  const out = await remember.run(remember.input.parse(input), ctx);
  if (out?.error) throw new Error(`dictation: ${out.error}`);
  return { heard, written, undo: undoIds(out) };
}

/** One thing dictation changed, as dictation/changes-since reports it and
 *  dictation/apply-changes replays it on another strut. Keyed by the pair,
 *  never a ref_id: the two graphs give the same pair different ids. */
export const Change = z.object({
  op: z.enum(["learn", "undo"]),
  heard: z.string().optional().describe("What dictation writes; absent for a term."),
  written: z.string().describe("How the user writes it: the form, else the entity's name."),
  name: z.string().optional().describe("The entity the pair is kept on, when `written` is another form of its name (BTC on Bitcoin, Itoi in Paul Itoi)."),
  term: z.boolean().optional().describe("A word learned with no mapping (P8)."),
  at: z.string().describe("When it was learned or undone (ISO)."),
});
export type ChangeT = z.infer<typeof Change>;
