import { z } from "zod";
import { defineStep } from "../../../core.js";
import { letters } from "../../../audio/lingo.js";
import { Learned, learn, readLexicon } from "./_shared.js";

export default defineStep({
  type: "dictation/add",
  description:
    "Adds a word to dictation's vocabulary by hand: dictation writes `heard` where the user means `written`. Stored as " +
    "dictation/correction stores a learn (on the entity that writes it, else a new word); `undo` is for dictation/undo. " +
    "`name` keeps it on the entity of that full name (`written` a part or another form of it, as a fix inside \"Paul Itoi\"); " +
    "`term` keeps only `written`, as a new word, with no mapping.",
  effect: "write",
  input: z.object({
    written: z.string().trim().min(1).describe("How the user writes it, e.g. 'Stakwork' or 'P8'."),
    heard: z.string().trim().min(1).describe("What dictation writes instead, e.g. 'stack work'."),
    name: z.string().trim().min(1).optional().describe("The full name `written` belongs to, e.g. 'Paul Itoi' for 'Itoi'; made as a person when nothing writes it."),
    term: z.boolean().optional().describe("Keep only `written`, as a new word: a code of its own (P8)."),
  }),
  output: Learned,
  async run(cfg, ctx) {
    if (!letters(cfg.heard) || !letters(cfg.written)) throw new Error("dictation/add: heard and written need letters or digits");
    return learn(cfg.heard, cfg.written, await readLexicon(ctx), ctx, cfg.term ?? false, cfg.name);
  },
});
