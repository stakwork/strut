# memory/* recall and duplicate matching

`npm run bench:memory` (`scripts/bench-memory.ts`, data in `scripts/bench-memory.json`;
outside `src/`, so not in `build/` or the desktop package) seeds a temp LadybugDB
through the real `memory/remember` and `memory/merge` (~165 facts: people,
places, projects, preferences, tasks, nicknames, facts superseded over time),
runs labelled queries through `memory/recall`, and probes remember's entity
matching with 48 near-duplicate names (each seed entity gets its own remember,
so two seeds collapsing into one shows up as a miss). `--verbose` lists misses;
`--out file.md` writes the table.

recall@k = share of a query's expected hits in the top k (out of min(expected, k));
MRR = 1 / rank of the first expected hit. Negatives are scored apart. Dedupe
"auto" = `status: matched`; "candidates" = matched or listed in `similar`. A
probe marked `auto: false` (initials, Paweł/Pawel) may be similar but counts as
a false positive if matched automatically.

Two query sets:
- **main** (101): written with the matcher, so the rules below were tuned
  against it.
- **held-out** (24): written after the review fixes, run once, and not tuned
  against: possessives, Will/William, everyday words that are nicknames (bill,
  rich), surnames that stem to names (Jones, Fisher), CJK, Cyrillic, C#/C++.

## Results (same fixture for all three)

| | main branch | first version | now |
|---|---:|---:|---:|
| main recall@1 / @5 / MRR | 0.506 / 0.552 / 0.541 | 0.851 / 0.937 / 0.889 | 0.828 / 0.914 / 0.869 |
| main negatives with a hit | 3/14 | 1/14 | 1/14 |
| main non-relevant in top 5 | 1.98 | 2.62 | 2.53 |
| held-out recall@1 / @5 / MRR | 0.762 / 0.857 / 0.783 | 0.571 / 0.738 / 0.659 | 0.905 / 1.000 / 0.952 |
| held-out negatives with a hit | 0/3 | 1/3 | 1/3 |
| held-out must-not hits | 1 | 4 | 0 |
| dedupe auto precision / recall | 1.00 / 0.22 | 0.80 / 0.30 | 1.00 / 0.30 |
| dedupe candidates precision / recall | 0.75 / 0.70 | 0.90 / 0.87 | 1.00 / 0.93 |

The first version's held-out score was worse than main's:
- no CJK at all (`[^a-z0-9]` dropped it);
- C++ auto-merged into C#, so it couldn't be found;
- Jones stemmed to Jon;
- everyday words matched people.

Main still beats now on two held-out kinds, where substring matching happens
to be right:
- **ordinary:** for "Rich", the cake fact ranks first.
- **symbol:** "C#" also returns C++ first, because both index as the word "c".

Main queries lost since the first version:
- "John" and "Johnny" no longer find Jon: John and Jonathan are separate names now.
- The held-out episodes added to the seed reshuffled two rank-1 results.

Held-out by kind, recall@1, main → now: nickname 0.25 → 1.00, possessive
0.33 → 1.00, surname 1.00 → 1.00, ordinary 1.00 → 0.67, non-Latin 1.00 → 1.00,
symbol 1.00 → 0.50.

### Steps (first version, main queries, recall@1 / @5 / MRR)

| step | r@1 | r@5 | MRR |
|---|---:|---:|---:|
| words + IDF only (no substring matching) | 0.356 | 0.395 | 0.383 |
| + light stemmer and prefix | 0.575 | 0.624 | 0.608 |
| + typos | 0.644 | 0.716 | 0.687 |
| + nicknames | 0.736 | 0.848 | 0.796 |
| + an entity's `name` facts as names | 0.770 | 0.853 | 0.813 |
| + predicate words (ontology names and aliases) | 0.793 | 0.882 | 0.833 |
| + "I/me/my" favours Self | 0.851 | 0.914 | 0.883 |
| + "X … with Y" hop | 0.862 | 0.937 | 0.898 |
| + entity name fit | 0.874 | 0.937 | 0.906 |

## Rules shaped by the fixture

Listed so nobody takes them for general truths:
- **Word lists:** `GENERIC` includes "app" (Peel app). `TITLES` includes
  grandma, grandpa, granny and nan (Grandma Rose). Other words of that kind
  are guesses.
- **The "with" hop** (who works with Kate) was written for two fixture
  queries. It fires only when the query has "with" and a predicate word.
- **Name fit** (an entity whose whole name matches ranks above longer names)
  was added for Lisbon vs Lisbon trip and Stakwork vs Stakwork offsite.
- **Thresholds and weights** were picked on this fixture, not swept: typos
  allow 1 edit from 5 letters and 2 from 9; weights are prefix 0.8,
  nickname 0.9, typo 0.6, predicate 0.8, Self ×1.5.
- **Predicate words** come from the ontology's aliases, which were written
  before the fixture. The fixture's paraphrases lean on them (job, eat,
  hate).
- **`ORDINARY`** (bill, will, rich, … expanded as nicknames only when
  capitalised) came from review, not from the fixture.

## Review fixes

- **nameKey** ignores only whitespace, `.`, `,`, `-`, apostrophes and
  `&`/and. Every other character counts, so C# ≠ C++ ≠ C,
  Олег Petrov ≠ Иван Petrov, and Paweł ≠ Pawel (ł does not fold; it's
  listed as similar instead). An initial (J Smith ~ Jane Smith) is similar,
  never a match.
- **Ties, deliberately:** a graph from before nameKey can already hold two
  entities with one key ("Ann-Lee", "ann lee"). byName tries the exact
  normalised spelling of a name or alias first (main's query, the fast
  path), then nameKey; within each, the oldest (`created_at, ref_id`). So
  the entity spelled as asked wins, else the oldest.
- **normalize** also drops Arabic harakat (U+064B–065F, U+0670) and Hebrew
  points and cantillation (U+0591–05C7, less the punctuation in that range:
  maqaf, paseq, sof pasuq, nun hafukha), so مُحَمَّد علي = محمد علي.
  Other combining marks stay, since Indic vowel signs are letters (कमल ≠ कमला).
- **Words** are `\p{L}\p{N}` in any script, and a possessive `'s` is dropped
  first (Katherine's → katherine). Text in a script without spaces (CJK,
  Thai, …) also matches as a substring. A query of only stop words returns
  nothing. Main substring-matched it, and "the" found Katherine.
- **Nicknames:**
  - "will" is no longer a stop word.
  - John and Jonathan are separate groups.
  - Everyday-word nicknames expand only when capitalised.
  - A nickname hit scores the node but not the name-fit boost.
  - Sandy, Dick and Hal are gone.
- **People's names aren't stemmed** (in nodes or queries), so Jones ≠ Jon
  and Fisher ≠ fishing. Only a-z words are stemmed at all.
- **One-word names** are similar only by exact word or nickname, never by
  typo or initial. Before this, "Pawel" flagged "Dr Patel".
- **`similar` lists the 3 closest:** word scores are same 1, nickname 0.9,
  typo 0.7, abbreviation 0.6, initial 0.5, and one-word names ×0.5. Ties
  go to the oldest.
- **Speed:**
  - The "with" hop indexes facts by predicate + object; substring IDF is
    memoised per call.
  - byName keys each distinct stored name once and prepares the probe once:
    16 ms per new entity over 5,000 same-type entities, down from 101 ms
    (JS only).
  - A nameKey memo would make that 12 ms. Dropped: it saves microseconds per
    name next to a database scan.

## Timings

Measured on a shared machine whose load average swung between 4 and 90, so
p50s moved 3× between runs. Recall below is the best of 7 runs per query
(6 queries), which load disturbs least; main and now alternated, two rounds
each. Synthetic data: 10 facts per remember, ~300 people, up to ~1,000
topics.

| | main branch | now |
|---|---:|---:|
| remember 1,000 facts (wall) | 20–28 s | 18–21 s |
| recall at 1,000 facts | 21–23 ms | 29–30 ms |
| recall at 3,000 facts | 45 ms | 62–64 ms |

Remember is at parity: the exact-name query still comes first, and the scan
runs only for a new entity. Recall costs ~1.4× main and grows linearly,
since the scan reads every live entity and fact per call. An earlier "~45 ms at 2,000 facts" was one run
on a busy machine. Past ~10k facts, take candidates from FTS and rank them
with this scorer.

## Rejected

- **Scaling by the share of query words matched:** no change.
- **A relative score cutoff:** less noise, but less recall.
- **Ladybug FTS** (BM25, Porter stemming) instead of the scan, on the first
  fixture: r@1 0.471 / r@5 0.569, worse than main. It has no typos,
  nicknames, predicate words or Self.
- **Embeddings:** not measured. The MiniLM model isn't cached here and
  downloading it was out of scope. What's left is mostly paraphrase (boss →
  manager, vegetarian vs vegan, getting married → wedding).

## Packaging (Peel)

- **FTS / VECTOR extensions:** not used. If needed later:
  - `LOAD EXTENSION '/abs/path/libfts.lbug_extension'` loads a local file
    (tested on 0.21.2).
  - The file is ~1.5 MB and ad-hoc signed. It's what `INSTALL fts` puts in
    `~/.lbdb/extension/0.21.0/osx_arm64/fts/`.
  - The desktop build would fetch it per arch, sign it with Peel's
    identity, bundle it, and load it by path, never `INSTALL`.
  - The FTS index follows inserts.
- **Embeddings:** not needed. `@huggingface/transformers` is ~16 MB and
  `onnxruntime-node` ~218 MB in node_modules, plus ~90 MB of MiniLM weights.

## Open

- **C# vs C++ in recall:** both index as the word "c". They stay separate
  entities, but a search for one ranks the other alongside it. Keeping
  symbols in recall's words would separate them. Not done.
- **Synonyms** (boss → manager): a word list would overfit. Embeddings or a
  model call are the real fix.
- **Noise is up:** ~2.5 non-relevant hits in the top 5, vs 2.0 on main.
  Fine for an agent; a search box might want a cutoff.
