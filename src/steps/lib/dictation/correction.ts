import { z } from "zod";
import { defineStep } from "../../../core.js";
import { isCommon } from "../../../audio/common-words.js";
import { entryWriting, lessons, wasUndone, type Lexicon } from "../../../audio/lingo.js";
import { Learned, learn, readLexicon, type LearnedT } from "./_shared.js";

export interface Edit {
  /** What dictation typed, and the field's text once the user edited it. */
  typed: string;
  edited: string;
}

export interface Mishearing {
  heard: string;
  written: string;
}

/**
 * What an edit teaches: the mishearings in it. The one decision a model can
 * later take over or second (same edit and lexicon in, pairs out); the rules
 * in audio/lingo.ts today. Whatever decides, the step still never writes a
 * pair the user undid or a word turned off for dictation.
 */
export async function judge(edit: Edit, lexicon: Lexicon): Promise<Mishearing[]> {
  return lessons(edit.typed, edit.edited, lexicon, isCommon)
    .flatMap((l) => (l.kind === "misheard" ? [{ heard: l.heard, written: l.written }] : []));
}

export default defineStep({
  type: "dictation/correction",
  description:
    "Learns from the user's edit of what dictation typed: each mishearing in it (dictation wrote `heard` where the user " +
    "writes `written`, a name or term that sounds like it) is remembered on the entity that writes it, or as a new word, " +
    "so the next transcription puts it right. Everyday swaps, rewrites, casing of everyday words, two names for one thing, " +
    "words turned off for dictation and pairs the user undid teach nothing. Only the pair is stored, never the sentence. " +
    "`dry_run` says what would be learned and writes nothing. Undo with dictation/undo.",
  effect: "write",
  input: z.object({
    typed: z.string().describe("What dictation typed into the field."),
    edited: z.string().describe("The same text after the user's edit."),
    dry_run: z.boolean().optional().default(false),
  }),
  output: z.object({ learned: z.array(Learned) }),
  async run(cfg, ctx) {
    const lexicon = await readLexicon(ctx);
    const pairs = (await judge({ typed: cfg.typed, edited: cfg.edited }, lexicon))
      .filter((p) => !wasUndone(lexicon, p.heard, p.written) && !entryWriting(lexicon, p.written)?.dictationOff);
    if (cfg.dry_run) return { learned: pairs.map((p) => ({ ...p, undo: [] })) };
    const learned: LearnedT[] = [];
    for (const p of pairs) learned.push(await learn(p.heard, p.written, lexicon, ctx));
    return { learned };
  },
});
