# The desktop strut's memory

What Peel's bundled strut (`node desktop.js`, Ladybug workspace, dictation
on) holds in memory, measured on Tom's Mac (16 GB, macOS 26) on 2026-10-30,
and what bounds it. Numbers are `footprint` (the physical footprint macOS
charges the process, compressed pages included — what Activity Monitor
calls Memory), rounded.

## What was seen

| When | Footprint | Of which |
| --- | --- | --- |
| Peel's strut, 15 h up (Tom, 2026-10-29) | 3.8 GB (3.7 GB compressed, 1.2 GB resident) | — |
| Peel's strut, 40 min up, Tom's workspace | 2.7 GB (2.5 GB compressed), peak 4.4 GB | main-thread JS heap 48 MB; two workers' heaps under 10 MB each |
| Peel's strut, 8 min after a relaunch | 3.3 GB, peak 3.3 GB | fixer worker + recognizer worker alive; VM_ALLOCATE 1.5 GB, MALLOC_LARGE 0.9 GB, MALLOC_SMALL 0.8 GB |
| the same, 16 min after the relaunch | 1.8 GB | the fixer unloaded (5 min idle): VM_ALLOCATE 83 MB; the recognizer still there |
| the shipped bundle on an EMPTY workspace, just booted | 0.3 GB, peak 0.44 GB | node + Ladybug + the seeds |
| the shipped bundle on Tom's workspace, just booted | 0.7 GB, peak 1.25 GB | the real workspace's boot (jobs, feeds, the second graph) |

The JS side is small and bounded: the main heap is ~50 MB after 40 min,
run controllers are deleted at run end, `LiveFeed` keeps 200 things a job
and job feeds go idle, rooms queue 1 000. The memory is NATIVE, in the
model workers:

| Model | Footprint while loaded | How it is loaded | Freed? |
| --- | --- | --- | --- |
| Parakeet (`parakeet-tdt-en-0.6b-v2`, int8, 650 MB on disk) | **+1.0–1.1 GB** (MALLOC_LARGE ~740 MB + MALLOC_SMALL ~360 MB), built in 0.9–1.3 s | sherpa `OfflineRecognizer` in the recognizer worker, on the first `/audio/transcribe` with it (Peel's pick) | **Never, before this change**: `decoder.ts` keeps one recognizer per key for the worker's life, and the worker lived as long as strut |
| Kroko (`zipformer-en-kroko`, the default) | +0.16–0.26 GB | the same | the same |
| Qwen fixer (`qwen3-1.7b-q4`, 1.1 GB GGUF) | **+1.6 GB** (VM_ALLOCATE: KV cache 4096 × 3 sequences + compute; the weights are a mapped file), RSS 2.5 GB while loading, ready in 2.1 s | node-llama-cpp in the fixer worker, on the first transcript with a vocabulary | Yes: `DictationFixer` unloads after 5 min idle, and the memory comes back (1.63 GB → 0.19 GB measured) |
| Ladybug (workspace graph, memory graph) | 26 MB per open graph with the default buffer pool (80 % of RAM); 2 MB with a 256 MiB pool | `new Database(path, 0, …)` | n/a — small; left as it is |

So a dictation session costs ~2.7 GB (Parakeet + fixer) on top of the
~0.7 GB base, the fixer's share returns after five idle minutes, and
Parakeet's never did. 0.7 + 1.1 + the fixer's residue is the 1.8–2.7 GB
seen hours later; the 3.8 GB after 15 hours is that plus a fixer session
in progress or a transcription's transient (a long recording's samples,
float32, in the worker). No leak was found: nothing grows per request.

## The change (this branch)

`createStt` now ends the recognizer thread once nothing has held it for
`idleMs` (ten minutes by default; `SttServiceOptions.idleMs`, `Infinity`
keeps it): every call holds it while in flight, and an open stream holds
it from `openStream` until `end()` / `close()`. The next call starts
another thread and builds the recognizer again (Parakeet: ~1 s, so the
first dictation after a quiet ten minutes answers in ~1.3 s instead of
~0.3 s). Same shape as the fixer's unload.

Measured with the real engine (the patched `stt.js` over the shipped
bundle, `idleMs` 5 s for the test):

| Step | Footprint |
| --- | --- |
| bare node | 16 MB |
| after a Parakeet transcription | 1 133 MB |
| 7 s after the last use (unloaded) | 508 MB |
| after the next transcription (cold, 1.27 s) | 916 MB |

**What stays**: closing the worker returns the recognizer but not all of
its malloc: 0.3–0.6 GB stays dirty (MALLOC_LARGE a constant ~300 MB,
MALLOC_SMALL 150–320 MB), varying run to run and not growing over six
load/unload cycles (36, 596, 429, 564, 382, 390 MB after each). It is
onnxruntime's allocator keeping pages it freed; a recognizer in a child
PROCESS instead of a thread would return it all, at the cost of a second
runtime per model. Not done: the compressor takes it, and it is bounded.

## The ceiling now

On Tom's workspace: ~0.7 GB idle with nothing dictated; ~1.2 GB idle after
a dictation session (base + the allocator's residue); ~3.4 GB during one
(base + Parakeet + the fixer), the fixer's part gone 5 minutes after the
last transcript and Parakeet's 10 minutes after. The peak while the fixer
loads is higher (RSS 2.5 GB for a moment).

## For Peel

Nothing to change. Two things to know:

- The first dictation after ten quiet minutes pays the recognizer's build
  (~1 s on top). If that shows, Peel could warm it when the dictation HUD
  opens (any `/audio/transcribe`, or `/audio/models`, starts the thread;
  only a transcription builds the recognizer).
- A restart-on-threshold in Peel is not needed for this: the footprint is
  bounded by the models, not by growth. If a strut is ever seen past
  ~3.5 GB with no dictation in the last ten minutes, that is new and worth
  a `process.report` (`kill -USR1 <pid>` opens the inspector on 9229;
  `NodeWorker.enable` lists the workers and their `workerData` says which
  model each hosts — how the numbers above were attributed).

## How to measure

```bash
# a strut's footprint, compressed share and peak
footprint --pid <pid>                  # categories; MALLOC_* and VM_ALLOCATE are the models
top -l 1 -stats pid,mem,cmprs,command -pid <pid>
# the JS heaps (main + workers) without stopping it
kill -USR1 <pid>; curl -s 127.0.0.1:9229/json   # then Runtime.evaluate process.report.getReport()
```
