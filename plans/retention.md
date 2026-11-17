# Retention: everything strut keeps, off the disk when it is old

> **Status (2026-11-17): proposed, one part built.** Evan asked for it on
> 2026-11-17: "everything should be included, artifacts, jobs, etc", in a
> simple way, and took the shape below ("Plan + reshape #705"). The
> rulings it still needs are in §8. Built: a run's log (#693, #698
> retention; #705 the archive, whose summary fields were changed to this
> plan's shape before it merged, so nothing written needs migrating).
> plans/run-archive.md is the record of that first part: the bucket, the
> object store, the sweep's budget, restore on read. This plan is
> everything after it.

## Why

A strut box fills its disk. One live swarm on 2026-11-15 held, under its
data folder (plans/run-archive.md):

| What | Size | What removes it before this plan |
|---|---|---|
| run artifacts (`artifacts/<runId>/`) | 51 GB | nothing: retention skips them on purpose |
| run logs (`events.jsonl`), in two workflows | 44 GB | `retain:` / `STRUT_RUN_RETENTION` (`src/retention.ts`), workflow runs only |
| job directories (`jobs/`) | 22 GB | `sweepJobs` (`src/jobs.ts`): an idle job's repositories after `STRUT_WORKDIR_TTL_DAYS`; its other files never. It runs on the next `job/dir` or kept checkout, with no timer |
| under `steps/` (the `step:` run bucket; `checks/` beside it) | 14 GB | nothing: the sweep walks workflow keys only |
| repository caches (`repos/`) | 13 GB | nothing |
| chats (`chats/`, `uploads/`) | not measured | nothing |

Each line has its own mechanism or none, and plans/run-archive.md planned
four more phases, each with its own record field, restore hooks and
setting. This plan makes them one rule.

## 1. The rule

Everything strut stores is one of two things.

- **A record** is history: it cannot be made again. It has a small
  **index** that stays on the disk for good, and **parts** that may leave.
- **A copy** can be made again: a repository cache, a working copy. It has
  no index and is never uploaded.

One sweep (the retention sweep: at boot, then hourly, with the scheduler)
applies two lines:

> **A record at rest past its window: its parts leave the disk.** With a
> bucket (`STRUT_ARCHIVE_S3_*`) they are uploaded first and the first read
> of a part brings it back; with none they are deleted. The index stays and
> says where each part is.
>
> **A copy unused past its TTL is deleted.**

Retention is about this disk, never about the record. With a bucket
nothing is lost; without one, what leaves is gone, which is why the
default window is "keep everything" when there is no bucket (§3).

## 2. The records

| Record | Index (stays) | Parts (leave; one object each) | At rest since | Held while | Deleted, never uploaded |
|---|---|---|---|---|---|
| a run, in every bucket: workflow, `step:`, `check:` | `run.json` | `log`: `events.jsonl`. `artifacts`: `artifacts/<runId>/` | `finishedAt` | running, `waiting`, `kept` | `callback.json`, `mcp.json`, `job-callback.json` (credentials) |
| a job | `jobs/<name>.json` | `files`: `jobs/<name>/` without its working copies | `usedAt` | a run holds it; it has holds (a pod) | its working copies (copies, §4) |
| a chat | `chats/<id>/meta.json` | `transcript`: `messages.jsonl`, `events.jsonl`. `uploads`: `uploads/<id>/` | its last turn | a turn is running | |

Agent sessions, conversations and the other small stores fit the same
table when they are worth it. A new kind is a row: where its index is,
what its parts are, when it came to rest, what holds it.

**One part, one object.** A run's log and its artifacts leave and come
back apart: an artifact link (an image in a chat, a deliverable) must not
pull a gigabyte log back, and a run's timeline must not pull its videos.
Inside a part, everything goes and comes back together.

### 2.1 The index answers every walk

What strut reads by itself, and any read across many records, reads the
index only. A part is read only for the one record someone asked for.
Otherwise eviction breaks the walk (no bucket) or restores the whole
archive (a bucket). #705 holds to this for logs with `localRuns`, and
lists the walkers it covers.

Known walks that read parts today, to move onto the index before their
records can leave:

- `costOf` and `spentToday` (`src/verify.ts`) read every `check:` run's
  LOG for the subject it verified (`run.start.verify.subject`) and the cost
  its steps reported (`reportedCost`). A check run's summary has to carry
  both before a `check:` run's log can leave.
- `artifactReferences` (`src/retention.ts`) reads summaries only. It stays.

## 3. The settings

| Setting | Default | Meaning |
|---|---|---|
| `retain:` on a workflow | (none) | How long that workflow's finished runs keep their parts on this disk: a window (`7d`) or a count (`{ runs: 20 }`) |
| `STRUT_RETENTION` | `7d` with a bucket; with none, keep everything | The window for every record nothing else names: runs of workflows with no `retain:`, `step:` and `check:` runs, idle jobs, chats |
| `STRUT_COPY_TTL` | `7d` | How long a copy unused stays: working copies, repository caches |
| `STRUT_ARCHIVE_S3_*` | off | Where parts go (plans/run-archive.md §1.1, unchanged). Set: eviction loses nothing. Unset: eviction deletes |

The first names stay readable: `STRUT_RUN_RETENTION` when
`STRUT_RETENTION` is unset (built, `fleetRetentionFromEnv`), and
`STRUT_WORKDIR_TTL_DAYS` (a number of days) when `STRUT_COPY_TTL` is unset.
A part a read restored stays one day, whatever the window (built,
`RESTORED_KEEP_MS`); that is not a setting.

The default differs with and without a bucket, and one sentence says why:
strut picks a window for you only when leaving loses nothing.

## 4. The copies

- **Working copies** in a job's directory (`jobs/<name>/<repo>`, recorded
  on the job's record as `repos`): what `sweepJobs` removes today, by the
  job's `usedAt`. They move onto the hourly sweep with the jobs.
- **Repository caches** (`repos/<host>/<owner>/<name>.git`): by last use
  (the cache's last fetch), skipping one a working copy still points at.
- **Per-run working copies** (`<artifacts>/<runId>/<repo>`, or
  `worktrees/<runId>/`) are removed when the run ends (`git/checkout`'s
  `onRunEnd`). A leftover one, from a run that crashed, goes as a copy.

A working copy can hold an agent's uncommitted edits. Removing it after
`STRUT_WORKDIR_TTL_DAYS` is today's behavior, unchanged here.

## 5. On the index

Each record's index carries one field for all its parts, the same shape
for every kind (built for runs: `RunSummary.parts`, `PartState`,
`ArchivedPart` in `src/core.ts`):

```json
"parts": {
  "log": {
    "archive": { "key": "box-1/runs/hello/1794804622653/events.jsonl.gz", "bytes": 10400634, "size": 7812001, "at": "…" },
    "evictedAt": "…",
    "restoredAt": "…"
  },
  "artifacts": { … }
}
```

- `archive`: the bucket holds the part, `bytes` long when it was uploaded,
  as a `size`-byte object.
- `evictedAt`: the part is not on this disk. With `archive` it is in the
  bucket; without it, it is gone.
- `restoredAt`: a read brought it back then; the sweep leaves it a day.
- No entry: on this disk, never uploaded.

A summary an older strut wrote (`logEvicted: true` + `evictedAt`, #693)
reads as `parts.log.evictedAt` (built, `upgradeSummary`).

Bucket keys: `<prefix>/<kind>/<group>/<id>/<part>`:
`runs/<workflow>/<runId>/events.jsonl.gz` (built),
`runs/<workflow>/<runId>/artifacts.tar.gz`, `jobs/<name>/files.tar.gz`,
`chats/<id>/transcript.tar.gz`.

## 6. How a part leaves and comes back

- **A file part** (a log) is gzipped and streamed into a multipart upload,
  checked by size both ways. Built (plans/run-archive.md §1.2, §1.3).
- **A directory part** (artifacts, a job's files, a chat's uploads) is a
  gzipped tar. `src/tar.ts` builds archives in memory from buffers,
  regular files only, so it cannot carry a multi-GB directory, symlinks or
  executable bits. The system `tar` through the shell service can, and
  streams into the same upload: no new dependency. Extraction refuses a
  path that leaves the part's directory. Above about 48 GiB compressed an
  upload needs a larger part size than the default.
- **Listing without restoring.** When a directory part is uploaded, its
  file list (paths, sizes) stays on the index, so `GET /artifacts/:runId`
  and a job's file list answer without a download.
- **A job run's files are the job's.** A run launched under a job writes
  into the job's directory, not its own artifacts: they leave with the
  job's `files`.
- **Restore on read**, part by part. Each part's readers call one
  `ensureLocal(record, part)` before they touch it, one restore at a time
  per part:
  - `log`: built (`FileRunStore.ensureLog`).
  - `artifacts`: `ctx.services.artifacts` (`read`, `list`, and `dir`,
    which hands out a path, so it restores before it answers),
    `GET /artifacts/:runId[/path]`, deliverables (`artifactRefs`).
  - a job's `files`: `job/dir`, `job/get`, the job file route.
  - a chat: its transcript read, its uploads route.
- **References.** Retention skips a run whose artifacts another run's
  summary names (`artifactReferences`), so no link breaks. With a bucket
  the reader restores, so the skip applies only when eviction deletes.
- **A record that changes after it was uploaded** (a resumed run, a job
  used again) is uploaded again over the same key, as the log is today:
  the record lives on the index, a run's resume drops it with the
  summary, and a job's `usedAt` moving past `archive.at` is the same
  signal.

## 7. Order of work

By what each frees, each a kind or a part added to the one sweep:

1. **A run's log.** Built (#693, #698, #705).
2. **A run's artifacts (51 GB)**: the `artifacts` part, the streaming tar,
   restore in the artifacts capability and route.
3. **Jobs (22 GB)**: the `job` kind (`files` part), and `sweepJobs` moves
   onto the hourly sweep with `STRUT_COPY_TTL` for its working copies.
4. **`step:` and `check:` runs (14 GB)**: the sweep walks every run key,
   after check run summaries carry their subject and reported cost
   (§2.1). Bucket keys for these keys (`step:clip/compute-times`) need a
   mapping without the colon.
5. **Repository caches (13 GB)**: copies, by last fetch.
6. **Chats**: the `chat` kind, once measured.

## 8. To rule

1. **Without a bucket, a record's window deletes all its parts.** A
   workflow with `retain: 1h` and no bucket loses its runs' artifacts
   after an hour too, not only their logs. That is "everything included";
   it is also a change for every workflow that has a `retain:` today.
2. **A job a conversation comes back to months later.** With a bucket
   `job/dir` restores its files. Without one they are gone after
   `STRUT_RETENTION` idle. Is the fleet window right for jobs, or do jobs
   need their own?
3. **`STRUT_COPY_TTL`**: the name, and that it replaces
   `STRUT_WORKDIR_TTL_DAYS`.
4. **From #705, still open**: whether a public visitor's read of one
   archived run restores it, and whether a job view (up to 100 runs) and
   a conversation page (20 to 100 turns) should restore, as they do now.

## Not planned

- A window per kind beyond `retain:`. One fleet window, one per workflow.
- Expiring an index. An index is small and is the record that the rest
  existed; deleting a workflow or a job is what removes it.
- Expiring the bucket. That is a lifecycle rule the deployer sets
  (plans/run-archive.md §1.5).
- Another protocol than S3 (plans/run-archive.md, "Decided").
- A status page (how much is archived, how much waits). The sweep's log
  lines are the report.
- A bulk restore, or a cap on restores. A day's keep is the only bound on
  what reads bring back.
