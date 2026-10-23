import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { anonymizeTexts, type AnonymizeOptions } from "../../../privacy/index.js";
import { WarningSchema, NOT_ANONYMIZATION } from "./_shared.js";

const Result = z.object({
  text: z.string().describe("the text with tokens like [PERSON_1] in place of what was found"),
  handle: z.string().describe("pvm_<24 hex> (memory vault) or pvf_<24 hex> (file vault): pass it to privacy/deanonymize"),
  counts: z.record(z.string(), z.number()).describe("distinct entities masked, by type"),
  entities: z.number(),
  warnings: z.array(WarningSchema).describe("partial detection the caller should act on; never contains original text"),
  detector: z.object({ rules: z.literal(true), gazetteer: z.literal(true), ner: z.boolean(), llm: z.boolean() }),
  vault: z.enum(["memory", "file"]),
});

const EXAMPLE = `- id: mask
  type: privacy/anonymize
  config:
    text: "{{ input.prompt }}"
    deny: ["Priya"]
- id: ask
  type: llm
  config: { prompt: "{{ mask.text }}" }
- id: back
  type: privacy/deanonymize
  config: { text: "{{ ask.text }}", handle: "{{ mask.handle }}" }`;

export default defineStep({
  type: "privacy/anonymize",
  description:
    `Mask personal data in a text before it leaves for a hosted model. ${NOT_ANONYMIZATION} ` +
    `Give exactly one of text / texts (a batch loads the model once and returns { results: [...] }, one handle per text). vault "memory" (default) lives in this process only; "file" is encrypted under the secret STRUT_ANONYMIZATION_VAULT_KEY and survives restarts. ` +
    `detectors.ner (default true) fails closed: if the NER model cannot load the step errors instead of continuing without it. privacy_level is reserved: only "off" is implemented. ` +
    `Output: { text, handle, counts, entities, warnings, detector, vault }.\n\n${EXAMPLE}`,
  input: z
    .object({
      text: z.string().optional().describe("one text to mask"),
      texts: z.array(z.string()).optional().describe("several texts; the output is { results: [...] }"),
      vault: z.enum(["memory", "file"]).default("memory"),
      ttl_minutes: z.number().positive().default(60).describe("how long the vault keeps the mapping; longer than the model call takes"),
      deny: z.array(z.string()).default([]).describe("words always masked, as PERSON (contacts, the user's own name)"),
      allow: z.array(z.string()).default([]).describe("words never masked"),
      detectors: z
        .object({ ner: z.boolean().optional().describe("default true"), llm: z.boolean().optional().describe("default false; a 1.7 GB model, ~3 s a text") })
        .optional(),
      min_score: z.number().min(0).max(1).default(0.6).describe("NER confidence floor"),
      privacy_level: z.enum(["off", "basic", "strict"]).default("off").describe("RESERVED: only off is implemented; the others warn and behave as off"),
      max_chars: z.number().int().positive().default(200000).describe("refuse a text longer than this"),
    })
    .refine((c) => (c.text === undefined) !== (c.texts === undefined), { message: "give exactly one of text or texts" }),
  output: z.union([Result, z.object({ results: z.array(Result) })]),
  async run(cfg, ctx?: StepContext) {
    const texts = cfg.texts ?? [cfg.text!];
    for (const t of texts) if (t.length > cfg.max_chars) throw new Error(`text is ${t.length} characters, over max_chars (${cfg.max_chars})`);
    const opts: AnonymizeOptions = {
      vault: cfg.vault,
      ttlMinutes: cfg.ttl_minutes,
      deny: cfg.deny,
      allow: cfg.allow,
      ner: cfg.detectors?.ner ?? true,
      llm: cfg.detectors?.llm ?? false,
      minScore: cfg.min_score,
      privacyLevel: cfg.privacy_level,
    };
    const results = await anonymizeTexts(texts, opts, ctx ?? {});
    return cfg.texts ? { results } : results[0]!;
  },
});
