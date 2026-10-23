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

/** Writes that dictation writes `heard` for `written`: the pair alone, on the entity that writes it or a new word. */
export async function learn(heard: string, written: string, lexicon: Lexicon, ctx: StepContext<unknown>): Promise<LearnedT> {
  const out = await remember.run(remember.input.parse(learnInput(heard, written, lexicon)), ctx);
  if (out?.error) throw new Error(`dictation: ${out.error}`);
  return { heard, written, undo: undoIds(out) };
}
