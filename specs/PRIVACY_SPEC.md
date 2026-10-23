# Private AI — pseudonymization before a hosted model

Status: built (`src/privacy/`, `privacy/*` steps, the seeded `private-ask`
workflow). One architecture for every consumer: Hive and Peel call the same
steps and the same workflow the same way. Strut has no consumer-specific code.

## 1. What it is, and is not

`privacy/anonymize` replaces personal data in a text with typed numbered
tokens (`[PERSON_1]`, `[EMAIL_2]`, `[DATE_1]`), keeps the mapping in a
**vault** under an opaque **handle**, and `privacy/deanonymize` puts the
originals back into a reply. A model sees "[PERSON_1] works at [ORG_1]" and can
still write a useful answer.

This is **pseudonymization, not anonymization**. Limits, stated plainly:

- **Clues are not masked.** "The night nurse at the corner clinic" identifies
  someone and has no name in it. Only names, places, organisations, dates,
  phones, emails, addresses, handles, urls and ids are masked. A
  quasi-identifier stage is a follow-up (§9).
- **English-oriented.** The NER model (`Xenova/bert-base-NER`) is English.
  Rules cover a few date and address forms in French, Spanish, German and
  Italian; other languages get the rules only.
- **Ids are pattern-based**, with no checksum (no Luhn): a card number is found
  by its shape.
- **No recall figure is promised.** The live suite (§8) asserts a floor on
  small synthetic fixtures; that is a regression guard, not a measurement.
- A token written literally in the original text (`[PERSON_1]`) is
  indistinguishable from ours when restoring. Not handled.

Detection is a pipeline of stages, merged by priority
`deny > rule > heur > ner > llm` (longest span wins within a level; `heur` and
`ner` share one): deny list → rules (`rules.ts`) and gazetteers
(`gazetteer.ts`) → NER → optional LLM. NER is **fail-closed**: with
`detectors.ner: true` (the default) a model that cannot load makes the step
fail with `ner_unavailable:`; it never continues without it.

## 2. Threat model

| | Protected | Not protected |
| --- | --- | --- |
| The hosted model provider reads the prompt | names, places, orgs, dates, phones, emails, addresses, ids found by the detectors | clues and anything the detectors miss (the `warnings` and the limits above) |
| The provider's logs or training | same as above | same |
| The vault at rest (`vault: file`) | AES-256-GCM, key derived from a deployment secret; `exp` and the id are authenticated | an attacker holding both the file and the secret |
| The vault in memory (`vault: memory`) | never written to disk; lives in this process; expires by TTL | a process memory dump |
| **Strut's own run files** | **nothing** (see below) | `prompt`, `answer`, anonymize `text`, deanonymize output |
| Someone with the strut API key | — | the key reads run files and can call `privacy/deanonymize` on a live handle |

### The run-file risk (read this)

The runner records **every step's input and output** (`events.jsonl`,
`run.json`, `GET …/runs/:runId/events`). So in a `private-ask` run the
original `prompt` input and the restored `answer` output are in plaintext in
that run's files, and so are `privacy/anonymize`'s `text` input and
`privacy/deanonymize`'s output. The masked text and the handle are harmless;
the originals are not.

**Handle-only convention (the mitigation for now).** A consumer that must keep
raw text out of run files calls `privacy/anonymize` in its **own process
boundary**: through the one-step endpoint `POST /steps/privacy/anonymize/run`
(§6.5; a step run is in memory, kept only with `keep: true`), then passes
**only the masked text and the handle** into any workflow, and calls
`privacy/deanonymize` at the edge, when it holds the reply. Do not pass
`keep: true`. Note the step-run *response* carries `events` that echo the step's
config, so the original text is in the response to the caller who sent it, which
is where it already was.

Runner redaction (marking a step's input/output sensitive so it is not
recorded) is a separate core-runner change and is not part of this work.

## 3. Step surface

All three are lib steps (`src/steps/lib/privacy/`). Descriptions in
`GET /steps` carry the pseudonymization warning and the run-file note.

**`privacy/anonymize`** — input

| Field | Default | |
| --- | --- | --- |
| `text` / `texts` | — | exactly one. `texts` loads the model once; output is `{ results: [...] }`, one handle per text |
| `vault` | `memory` | `memory` or `file` |
| `ttl_minutes` | 60 | vault lifetime; longer than the model call |
| `deny` | `[]` | words always masked, as PERSON (contacts, the user's own name); whole word, case-insensitive |
| `allow` | `[]` | words never masked (case-insensitive) |
| `detectors` | `{ ner: true, llm: false }` | `llm` is off by default (§7) |
| `min_score` | 0.6 | NER confidence floor |
| `privacy_level` | `off` | reserved (§9): `basic` / `strict` add the warning `privacy_level_not_implemented` and behave as `off` |
| `max_chars` | 200000 | a longer text is an error (the message names the size, never the text) |

Output (one text; a batch is `{ results: [that, …] }`):

```json
{
  "text": "[PERSON_1] wrote to [EMAIL_1] on [DATE_1].",
  "handle": "pvm_3f9c0a7d41b2e85d6c1a09ff",
  "counts": { "PERSON": 1, "EMAIL": 1, "DATE": 1 },
  "entities": 3,
  "warnings": [],
  "detector": { "rules": true, "gazetteer": true, "ner": true, "llm": false },
  "vault": "memory"
}
```

`warnings` is `[{ code, message, count? }]` and **never contains original text
or a value**. Codes: `ner_unaligned_spans` (NER spans that could not be aligned
to the text and were dropped; `count`), `llm_invalid_output` (reply not valid
JSON for a chunk; `count`), `llm_rejected_candidates` (`count`),
`privacy_level_not_implemented`. A warning means partial detection: the
consumer decides what to do (§6.4).

**`privacy/deanonymize`** `{ text, handle, destroy? }` →
`{ text, restored, unknown_pseudonyms, destroyed }`. `destroy` defaults to true
for memory handles and false for file handles. An unknown or expired handle is
an error (`vault_not_found:`). Tokens are matched tolerantly (case, missing
brackets, spaces); a token the vault does not know is left as written and
counted in `unknown_pseudonyms`, never guessed. **The output contains real
personal data.**

**`privacy/destroy`** `{ handle, rethrow? }` → `{ destroyed }`. With `rethrow`
it destroys and then fails with that message: an `onError` handler passes
`"{{ $error.message }}"`, so the run still fails with the failed step's error.

**`private-ask`** (seeded workflow, category `privacy`): `privacy/anonymize` →
`llm` (sees only the masked text, told to keep tokens verbatim) →
`privacy/deanonymize`. If the `llm` step fails its `onError` destroys the vault
and rethrows: the run fails at `llm` with the model's error (what a callback's
`error.message` carries), and `deanonymize` never runs.

- input `{ prompt, model?, system?, vault? = "memory", ttl_minutes? = 60, deny?, allow? }`
- output `{ answer, handle?, report: { counts, entities, warnings, restored, unknown_pseudonyms } }`
  — `handle` only for `vault: file`. The mapping is never output.
- Not `peer: true`: another strut cannot launch it.

## 4. Vault, handles, keys

Handles are **only** `pvm_<24 hex>` (memory) or `pvf_<24 hex>` (file). Nothing
follows, and no key material is ever in a handle.

- **Memory**: a process-global map; expired entries are purged on every put
  and get. Lives in one strut process: a restart, or another instance, does not
  have it.
- **File**: `<dataDir>/privacy/vault/<id>.enc`, mode 0600 in a 0700 directory,
  not in the artifacts store; deleted with `fs.rm`. Format
  `{ v: 2, kid, exp, salt, iv, ct }`, AES-256-GCM, key =
  HKDF-SHA256(secret, salt, info `strut-privacy-vault`), AAD = `<id>:<exp>`, so
  a changed `exp` or a file renamed to another id fails to decrypt. Expired
  files are removed on read and by a bounded sweep (100 files) on each write.
- **The key** (`vault: file` only): the secret `STRUT_ANONYMIZATION_VAULT_KEY`,
  the only name read. Without it the step fails with
  an error naming `STRUT_ANONYMIZATION_VAULT_KEY`; there is no keyless mode.
  `kid` is the first 8 hex of sha256(secret name + ":" + value). A vault
  written under another key is a clear error, so **rotating the key orphans
  existing file vaults** (they expire by TTL or are deleted with `destroy`).
- **Per-actor caveat.** Secrets resolve through the run's principal: an actor's
  own value first, then the deployment's. A run launched by an automation may
  not see the actor's secret, and a later call by another actor would see a
  different key, then fail with a `kid` error. Set a **deployment-level** secret
  for file vaults.
- **The seam.** `src/privacy/keys.ts` is the only code that reads those secret
  names: `interface KeyProvider { get(ctx, { vault: "file", owner? }): Promise<{ kid, material } | null> }`,
  default `secretKeyProvider`. `vault.ts` takes a `KeyProvider`; a host can inject
  its own through `ctx.services.privacy.keys` (a per-user or envelope-encryption
  provider), with no change to the steps or the file format.

## 5. Models and configuration

- NER: `Xenova/bert-base-NER`, dtype `q8` (~110 MB), run with
  `@huggingface/transformers` in a **worker thread** of this process
  (`ModelWorker`, `src/model-worker.ts`; `workerNer`), lazily imported; one warm
  pipeline per process, concurrent first use shares one load. A forward pass is
  synchronous native work, and on the main thread it would block every request
  the server is handling. No child process.
- Model files are cached under `<model dir>/privacy/<model id>` (the model dir is
  `STRUT_MODEL_DIR`, see `src/model-dir.ts`). The model dir and
  `STRUT_PRIVACY_OFFLINE` are read on the main thread and handed to the worker
  (`privacyModelOptions`): a worker sees the environment the env scrub left. **The first use downloads them**,
  which takes seconds to minutes and needs the network: pre-download in a
  deployment (run one anonymize at build or boot) and set
  `STRUT_PRIVACY_OFFLINE=1` to forbid downloads afterwards (a missing model then
  fails closed).
- `ctx.services.privacy` is the injection seam (`PrivacyServices`): `ner`, `llm`
  engines (what tests use, so no model is downloaded), `keys`, `vaultDir`.

## 6. How Hive and Peel call it

Same for both. Request shapes are from `specs/API.md` §3, §7 and
`specs/CALLBACKS.md`; add `Authorization: Bearer $STRUT_API_KEY` where a key is
set and `x-strut-actor` to name the person.

### 6.1 Opt-in is the consumer's choice

Strut has no "private mode" setting. A request is private only if the consumer
launches `private-ask` (or the three-step sequence) instead of a plain `llm`
workflow. A consumer that wants a per-user or per-workspace "private mode" keeps
that flag itself and maps it to *which workflow it launches*.

### 6.2 What to send

Send the **final** dictated transcript only: after dictation has finished, never
partial or streaming drafts, once per utterance, so there is one handle per
utterance. Put known names in `deny` (contacts, the user's own name) and words
to keep in `allow`.

```bash
curl -X POST $STRUT/workflows/private-ask/run -H 'Content-Type: application/json' -d '{
  "input": {
    "prompt": "Remind me to call my sister Beatriz about the flight on March 3rd",
    "deny": ["Beatriz", "Evan"],
    "allow": ["Friday"]
  },
  "callback": { "url": "https://consumer.example/strut/run-end" }
}'
# → 202 { "runId": "1790436489808", "callback": true }
```

### 6.3 Callback

When the run settles strut POSTs once to `callback.url`
(`specs/CALLBACKS.md` §2), delivery retried a few times; the output is the
workflow's `output`:

```json
{
  "event": "run.end",
  "workflow": "private-ask",
  "runId": "1790436489808",
  "status": "success",
  "output": {
    "answer": "Here is a reminder to call Beatriz about the flight on March 3rd. …",
    "report": { "counts": { "PERSON": 1, "DATE": 1 }, "entities": 2, "warnings": [], "restored": 2, "unknown_pseudonyms": 0 }
  },
  "durationMs": 4120
}
```

The `answer` is already de-anonymized. `status: "error"` carries
`error: { message }` instead of `output`. Without a callback, tail or poll the
run (`API.md` §4–§5).

Memory vaults live only in one strut process, and `private-ask` keeps all three
steps in that process, so it is safe with the default. A split flow (anonymize
now, deanonymize in a later request), or a multi-instance or serverless
deployment, must use `vault: "file"` with a deployment-level
`STRUT_ANONYMIZATION_VAULT_KEY` on a shared `dataDir`; `private-ask` then also
returns the `handle`. Set `ttl_minutes` above the longest expected model
latency; an expired handle is an error, not a silent loss.

### 6.4 Handling warnings and unknown pseudonyms

`report.warnings` non-empty means partial detection (an NER span dropped, an LLM
reply unusable, `privacy_level` not implemented). That is the consumer's policy:
for example refuse to show or send the answer, or ask the user. A failed run
with `ner_unavailable:` means the model could not load; nothing was sent.
`report.unknown_pseudonyms > 0` means the model invented tokens that are not in
the vault; they are left as written in the answer, so show them as such or
retry.

### 6.5 Direct step use for custom flows

For raw text that must stay out of run files (§2), call the steps yourself with
the one-step endpoint (`API.md` §7), `POST /steps/:type/run { config }`, which
returns `{ runId, status, output?, error?, events }` and keeps nothing:

```bash
# 1. mask, in the consumer's own process boundary
curl -X POST $STRUT/steps/privacy/anonymize/run -H 'Content-Type: application/json' -d '{
  "config": { "text": "Call Beatriz on (416) 555-0142", "vault": "file", "ttl_minutes": 30 }
}'
# → { "status": "success", "output": { "text": "Call [PERSON_1] on [PHONE_1]", "handle": "pvf_…", … }, … }

# 2. the hosted call, in the consumer's own code, with output.text only

# 3. restore at the edge
curl -X POST $STRUT/steps/privacy/deanonymize/run -H 'Content-Type: application/json' -d '{
  "config": { "text": "I called [PERSON_1].", "handle": "pvf_…" }
}'
# → { "output": { "text": "I called Beatriz.", "restored": 1, "unknown_pseudonyms": 0, "destroyed": false }, … }
```

Use `vault: "file"` here: two separate requests may not reach the same process,
and the file vault needs the secret. Destroy a handle you will not restore with
`POST /steps/privacy/destroy/run { "config": { "handle": "pvf_…" } }`. Passing
only the masked text and the handle into a workflow of your own (e.g. as `input`)
keeps the originals out of its run files.

## 7. The optional LLM detector

`detectors: { llm: true }` adds a second detector for nicknames and unusual names
(`onnx-community/Qwen2.5-1.5B-Instruct`, q4, in a worker thread of its own, so a
3 s call never holds up the NER; `workerLlm`). It
is **off by default and stays out of the default path**: the download is about
1.7 GB and a text costs roughly 3 s on CPU. Its output is trusted only for short,
capitalised, digit-free strings found verbatim in the text. An invalid reply is
the warning `llm_invalid_output`, a rejected candidate counts in
`llm_rejected_candidates`.

## 8. Tests

`npm test` runs the hermetic suites (`src/privacy/*.test.ts`: rules, heuristics,
`typeFix`, `resolve`, pseudonymize, restore, vault, keys, NER and LLM post-
processing with fake engines, the steps and `private-ask` with a fake `llm`).
`npm run test:privacy` (`STRUT_PRIVACY_LIVE=1`) loads the real NER model on ~20
synthetic fixtures (`src/privacy/fixtures/recall.jsonl`): a recall floor and an
anonymize → echo → deanonymize round trip. It downloads the model on first run.

## 9. Extensibility and what remains

- **Stages.** `detect.ts` exports `Stage = { name, priority, detect(text, opts) }`
  and `detectAll(text, stages, opts)`, which merges the candidates through
  `resolve()`. The `Span.src` union already reserves `"clue"` (priority 3.5), and
  vault map entries are `{ type, value, mode?, gen? }` (`mode` and `gen` are
  reserved and ignored today).
- **`privacy_level`.** A follow-up change adds a quasi-identifier ("clue") stage
  and gives `basic` / `strict` meaning. It plugs in as one more `Stage` plus
  `mode` / `gen` on map entries and a matching branch in restore; nothing in the
  step surface changes. Until then `basic` / `strict` warn and behave as `off`.
- **Remaining:** the full benchmark as a live suite, an independent held-out
  evaluation set, and runner-level redaction of sensitive steps (§2).
