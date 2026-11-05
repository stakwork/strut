# Proposals index — perf notes (PR-ready)

**Problem.** `GET /proposals?status=pending` did a `readdir` of `<dataDir>/proposals/`, read and parsed *every* file
(each holds the full tool `input`), then filtered. Files are never removed, so cost grew without bound; a poller
every 2–4 s piled up 100+ in-flight scans, each holding every parsed record → OOM / 100 % CPU.

## Design
- `src/proposals-index.ts`: one in-memory `ProposalIndex` per root (Map keyed by root), built lazily (and warmed at
  `createStrut`) by a streamed `opendir` with 32 parallel reads. Every writer (`createProposal`, `decideProposal`,
  `markReported`) goes through `ProposalIndex.write` (file, then index). Lists/filters/paging answer from memory, no
  file reads; only `readProposal` (`GET /proposals/:id`) reads a file (then `archive/`).
- What is held: **full** records for pending / accepted / failed (a list still carries `input` for what a person
  decides on; a failed retry and a step's `after` need the input); **compacted** for applied / rejected.
- Compaction: `input`, `decision.input` and a `result.output` > 4 KB → `{ _compacted: true, bytes }`, in the same
  write that records `applied` / `rejected` — i.e. after the step ran. The decide response is still whole.
  `failed` is never compacted (retry flow). Idempotent; legacy files work unchanged.
- `memo(key, fn)`: single-flight + cache for `STRUT_PROPOSALS_CACHE_MS`; entries are tied to a generation bumped on
  every write, so a decision is visible at once. The route key is scope + actor + query; the cached value is the JSON body.
- `GET /proposals` takes `limit` (1–500, default 100) and `offset`; response `{ proposals, total, next? }`; bad values 400.
  Internal callers (`listProposals`) get everything.

## Env
| var | default | |
|---|---|---|
| `STRUT_PROPOSALS_CACHE_MS` | 1000 | list cache; 0 = off (overlapping calls still share one) |
| `STRUT_PROPOSALS_RETENTION_DAYS` | 30 | decided (applied/rejected) older than N days → `<root>/archive/`; 0 = forever |
| `STRUT_PROPOSALS_COMPACT` | on | `0`/`false` keeps inputs of decided records |

## Deploy / migration
Nothing manual. First boot builds the index, then compacts legacy decided files and archives old ones in the
background (8 at a time; lists are served meanwhile and wait only for the index build). Archived proposals leave the
lists but `GET /proposals/:id` still finds them. Single-process assumption: files written by another process are not
seen until restart.

## Poller
Nothing in this repo polls `/proposals` (checked `web/src` — `getProposals` is called once per `JobTimeline` job/usedAt
change, `getRunProposals` once per `RunOverview` run; the only intervals are active-runs 5 s (hidden-aware), apps 30 s,
automations 10 s, chat meta, app usage; `kit/src`, `src/apps` and the `proposal/*` steps have no poll loop). It is
an external client (Hive, or an app calling `proposal/list`). The cache + single-flight + limit make it cheap regardless.

## Benchmark
`npx tsx scripts/bench-proposals.ts --mode old|new --dir <dir> --callers N [--rounds R]`
(`--dir` is generated with 20,000 files × ~20 KB when empty; the old scan is embedded for comparison). 
20,000 files (~860 MB), 1 cold process, all callers at once, `status=pending`:

| | callers | p50 | p99 | wall | peak RSS | peak heap |
|---|---|---|---|---|---|---|
| old scan | 50 | 65.6 s | 65.6 s | 65.6 s | 312 MB | 158 MB |
| old scan | 200 | 284 s | 284 s | 284 s | 690 MB | 465 MB |
| index (incl. cold build + background compaction) | 50 | 2.9 s | 2.9 s | 2.9 s | 220 MB | 80 MB |
| index | 200 | 3.1 s | 3.1 s | 3.1 s | 223 MB | 79 MB |
| index, 25 rounds × 200 (5,000 calls) | 200 | 0 ms | 3.0 s (the first, build) | 3.0 s | 220 MB | 82 MB |

Warm (tests): 200 concurrent pollers p50 4 ms / p99 4 ms, 1 computation, 0 file reads; 400 polls heap Δ ≈ 6 MB.
