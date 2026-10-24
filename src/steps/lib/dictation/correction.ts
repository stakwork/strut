import { z } from "zod";
import { defineStep } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { FIX_TIMEOUT_MS, within } from "../../../audio/fixer.js";
import { mishearings } from "../../../audio/lingo.js";
import { Learned, learn, readLexicon, type LearnedT } from "./_shared.js";

/** How long a cold fixer may take to load before an edit is let go: the
 *  client sends it once, so it waits for the model rather than lose it. */
const LOAD_MS = 60_000;

/** Characters a side: a long dictation is a few thousand. */
const MAX_TEXT = 20_000;

export default defineStep({
  type: "dictation/correction",
  description:
    "Learns from the user's edit of what dictation typed: each mishearing in it (dictation wrote `heard` where the user " +
    "writes `written`, a name or term that sounds like it) is remembered on the entity that writes it, or as a new word, " +
    "so the next transcription puts it right. The user's fixer model (dictation/use) judges each short change that " +
    "sounds alike, and a name that sounds like a real word (stadium → Stadeum) is learned too; a change from a code of " +
    "its own (PH → P8) keeps only the new word, with no mapping. Everyday swaps, rewrites, casing of everyday words, two names for one thing, words turned off for " +
    "dictation and pairs the user undid teach nothing. With no fixer active (dictation/models: none picked, or the pick " +
    "not installed yet) nothing is learned and `learned` is empty, so a client need not send edits then; nor when the " +
    "fixer is too slow. " +
    "Only the pair is stored, never the sentence. Send an edit once it settles. Undo with dictation/undo.",
  effect: "write",
  // Bounded: the edit is diffed word by word on strut's thread (quadratic in its length).
  input: z.object({
    typed: z.string().max(MAX_TEXT).describe("What dictation typed into the field."),
    edited: z.string().max(MAX_TEXT).describe("The same text after the user's edit."),
  }),
  output: z.object({ learned: z.array(Learned) }),
  async run(cfg, ctx) {
    const fixer = await (ctx.services as StrutCapabilities | undefined)?.stt?.fixer?.current();
    if (!fixer || !(await within(fixer.ready().then(() => true), LOAD_MS))) return { learned: [] };
    const lexicon = await readLexicon(ctx);
    const pairs = (await within(mishearings(cfg.typed, cfg.edited, lexicon, fixer), FIX_TIMEOUT_MS)) ?? [];
    const learned: LearnedT[] = [];
    for (const p of pairs) learned.push(await learn(p.heard, p.written, lexicon, ctx, p.term));
    return { learned };
  },
});
