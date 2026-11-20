# Private AI

Pseudonymization before a hosted model: the `privacy/*` steps and the model wrapper.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Key concepts

- **Private AI — pseudonymization** (`specs/PRIVACY_SPEC.md`; `src/privacy/`,
  `privacy/*` steps, the seeded `private-ask`). Detect (deny > rule > heur >
  ner > llm, `Stage` pipeline) → typed numbered tokens → vault under a handle
  (`pvm_<24 hex>` in-process, `pvf_<24 hex>` encrypted file; no key-in-handle
  mode). The key is looked up in ONE place, `keys.ts`'s `KeyProvider`. NER runs
  in a worker thread of this process (`workerNer` over `ModelWorker`; the LLM
  detector in one of its own) and fails closed; a dropped span is a `warnings` entry, never
  silent, and no warning or log carries original text. The runner records step
  inputs/outputs, so raw text passed to a step is in run files: callers that
  must avoid that anonymize in their own step run and pass only masked text +
  handle on. `privacy_level` is reserved (only `off`).
  **The model wrapper** (specs/PRIVACY_SPEC.md §10; opt-in via the `privacy`
  setting of src/extensions.ts, off by default): an AI SDK middleware
  (`middleware.ts`) masks what a hosted provider is sent and restores what
  comes back, for every model `resolveModel()` builds — no workflow, step or
  tool changes. Each message part is masked ONCE and its masked form stored
  (`session.ts`, `transcript.ts` memory / `transcript-file.ts` under
  `<dataDir>/privacy/transcripts` with `STRUT_PRIVACY_TRANSCRIPTS=file` and a
  vault key; TTL `STRUT_PRIVACY_TRANSCRIPT_TTL_HOURS`); the model's own output is
  stored RAW and stamped (`providerMetadata.strutPrivacy`, `stamp.ts`) so later
  calls resend it byte for byte — the prompt cache and signed thinking need it.
  Tool-call inputs are restored before the tool runs (`tool-restore.ts`;
  `privacy: "keep"` on a step def opts a tool out); `tool-guard.ts` refuses an
  invented placeholder for a side-effecting tool (`tool-policy.ts`, `sideEffects:
  true` / `effect: "write"` on a def). `policy.ts` + `refine/` hold the per-type
  mask list (DATE, TIME, URL, LOC visible by default; URL and DATE refined).
  Everything privacy needs from core comes through `src/privacy/host.ts`, the
  only file there that imports from outside the folder; `privacy/boundary.test.ts`
  fails on any other import across the line, on a core file other than
  createStrut.ts / index.ts reaching into privacy/, and on the word in core code.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/steps/lib/privacy/`

privacy/anonymize, deanonymize, destroy over src/privacy: typed outputs, `warnings` instead of silent drops, ner fail-closed, vault "file" needs the secret. Run files record step inputs and outputs, so original text is in them in plaintext (the handle-only convention in the spec is the mitigation)

### `src/privacy/`

Private AI (specs/PRIVACY_SPEC.md): PSEUDONYMIZATION before a hosted model, for any consumer (Hive, Peel) alike. rules.ts (RULES_LEGACY / RULES_NEW / RULES_HEUR, regexes tuned: copy exactly), gazetteer.ts (ORG/LOC data, STOP), detect.ts (ruleSpans, denySpans, `resolve` with a sorted-interval index, typeFix, `Stage` + `detectAll`: the plug-in seam for a later clue stage), ner.ts (transformers.js token-classification, one pipeline per thread, run in a worker thread by default — `workerNer` over `ModelWorker`, its cache dir and offline flag read on the main thread — `NerEngine` = the test seam, pure `groupAndAlign` / `nerPostprocess`), llm.ts (optional, off by default, its own worker — `workerLlm` — `LlmEngine` seam), pseudonymize.ts, restore.ts, vault.ts (memory Map | AES-256-GCM files under `<dataDir>/privacy/vault`, handles ONLY `pvm_`/`pvf_` + 24 hex, AAD id:exp), keys.ts (`KeyProvider`: the ONLY reader of STRUT_ANONYMIZATION_VAULT_KEY), models.ts, chunk.ts, types.ts, seed.ts (`private-ask`, `createStrut({ privacyWorkflows: false })` opts out), index.ts (`anonymizeTexts` / `deanonymizeText`, `ctx.services.privacy` = injection seam for engines, keys, vaultDir). `fixtures/recall.jsonl` + `privacy.live.test.ts` (`npm run test:privacy`, opt-in)
