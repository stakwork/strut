import { z } from "zod";
import { defineStep } from "../../../core.js";
import { isCommon } from "../../../audio/common-words.js";
import { Words, letters } from "../../../audio/lingo.js";
import { Learned, learn, readLexicon } from "./_shared.js";

export default defineStep({
  type: "dictation/add",
  description:
    "Adds a word to dictation's vocabulary by hand: dictation writes `heard` where the user means `written`. Stored as " +
    "dictation/correction stores a learn (on the entity that writes it, else a new word); `undo` is for dictation/undo. " +
    "`applies` is false when `heard` is one everyday word, which the rewrite never replaces on its own.",
  effect: "write",
  input: z.object({
    written: z.string().trim().min(1).describe("How the user writes it, e.g. 'Stakwork' or 'P8'."),
    heard: z.string().trim().min(1).describe("What dictation writes instead, e.g. 'stack work'."),
  }),
  output: Learned.extend({ applies: z.boolean() }),
  async run(cfg, ctx) {
    const keys = new Words(cfg.heard).keys;
    if (!letters(cfg.heard) || !letters(cfg.written)) throw new Error("dictation/add: heard and written need letters or digits");
    const applies = keys.length > 0 && !(keys.length === 1 && isCommon(keys[0]!));
    return { ...(await learn(cfg.heard, cfg.written, await readLexicon(ctx), ctx)), applies };
  },
});
