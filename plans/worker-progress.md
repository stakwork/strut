# Worker progress — XP, levels, friendly rejections

Status: BUILDING (2026-11-24). Built: XP and levels on `task/me` (ledger
`payeeEarned`, `src/tasks/levels.ts`) and the level card on top of Tasks
(card A). Next: the account widget's level, `LevelBadge` / `XpGain` for
custom apps, friendly rejections.

Source: the "Stack Play" brief (a gamified worker experience) and its mockup.
"Stack Play" is only a name idea for Tasks (`strut/worker`).

## The decision

**XP is a worker's lifetime earnings in sats on this server.** Earn 500
sats, have 500 XP. Levels are a ladder of round numbers: Level 1 at 10k
sats, ×10 every ten levels, the last at all 21M bitcoin. Then friendly
rejections.

The foundation lives in strut's task layer; Tasks is the central place to see
it; custom apps (a server's book-scanning app, say) get it for free and may
show "+50 XP" as it happens.

## What counts as XP

XP = every earning booked for the worker, less what was taken back.

- **Withdrawing does not lower it.** It is lifetime, not balance.
- **Held earnings count** (they show in the balance already). A rejection
  inside the hold takes the pay back, and the XP with it. On a pay-on-OK
  type nothing is booked before the OK, so its XP never drops.
- **Starting sats from an invite do not count**: they are not task pay.
- **Per server.** The ledger is per server; a worker on two servers has two
  levels.
- **Known cost:** XP cannot reward unpaid things (a good retake, a lesson).
  If that is wanted later, it is a second, separate number, not mixed into
  this one.

The ledger already keeps it: `payees` holds each worker's running
`accepted` and `taken_back`, so `payeeEarned(worker)` = accepted − taken
back is one row read, and the whole server-side XP.
No new table, no XP events, no migration, and nothing can double-count
because a `pay` row is unique on task + worker.

## Levels

Round numbers on a ladder (`src/tasks/levels.ts`, the same on every
server). Level 1 at 10k sats, about one book of pages. Within each ten
levels the steps are 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, then ×10. Below
10k a worker is Level 0. The last level is all 21M bitcoin: out of reach.

| Level | Sats | Level | Sats |
| --- | --- | --- | --- |
| 1 | 10,000 | 14 | 200,000 |
| 2 | 12,000 | 15 | 250,000 |
| 3 | 15,000 | 16 | 300,000 |
| 4 | 20,000 | 17 | 400,000 |
| 5 | 25,000 | 18 | 500,000 |
| 6 | 30,000 | 19 | 600,000 |
| 7 | 40,000 | 20 | 800,000 |
| 8 | 50,000 | 21 | 1,000,000 |
| 9 | 60,000 | 22 | 1,200,000 |
| 10 | 80,000 | 23 | 1,500,000 |
| 11 | 100,000 | 24 | 2,000,000 |
| 12 | 120,000 | 25 | 2,500,000 |
| 13 | 150,000 | … | … |

Then 10M at 31, 1 BTC at 41, and 21M BTC at 115.

Why this shape: each level costs about 25% more than the last, so later
levels slow down, but numbers stay round. A curve with 10% steps stays
faster later (every 1–2 days after a month) but lands on numbers like
6,105. The first curve, 33% steps fitted so Level 99 was 21M BTC, was
too slow: a week per level after a month.

Names per level are optional and decided separately. A level is shown, never
used to grant work: who may take which task type stays the grants, tests and
standing it is today.

## Where it lives

```
ledger (payees)    ──►  payeeEarned(worker)
                              │
src/tasks/levels.ts  ──►  task/me → xp: { sats, level, fromSats, toSats }
                              │
        ┌─────────────────────┼──────────────────────────┐
  account widget          Tasks (WorkerPage)        a custom app
  (host, every app)       the full level card        useWorker() has xp;
  "Lv 4" + bar            and the ladder             strut/views XpGain
```

1. **Ledger** — `payeeEarned(worker)` (SQLite and memory, off `payees`).
2. **Levels** — `levelOf(sats) → { level, fromSats, toSats }`, pure, tested.
3. **`task/me`** — adds `xp: { sats, level, fromSats, toSats }`. Always on: one figure the balance read already has.
   Every worker app already calls `task/me`, so none needs a new grant.
4. **The account widget** (`web/src/components/AccountWidget.tsx`) — strut
   draws it over every worker app and it already runs `task/me` for the
   balance. It shows the level and a thin bar. This is how XP bubbles up into
   custom apps with no change to them.
5. **Tasks** (`WorkerPage` home) — the full card: level, XP bar with
   "N sats to Level 5", and the ladder. The XP bar and the balance stay two
   cards: one is everything ever earned, the other is what can be withdrawn.
6. **Custom apps** — `useWorker()` already returns `task/me`, so `xp` is
   there. `strut/views` exports two small pieces: `LevelBadge` and `XpGain`
   ("+50 XP", and "Level 5!" when it crosses `toSats`). After a submit the
   page knows the task's pay, so it can show the gain at once ("+50 XP once
   OK'd" on a pay-on-OK type). The next `task/me` read is the truth.

## Friendly rejections

A type gets an optional `reasons` map: a code to a title and tip in each
language.

```yaml
reasons:
  not_a_page:
    en: { title: "Almost there!", tip: "We couldn't find a book page. Show the whole page, well lit, without your hand over it." }
    es: { title: "¡Casi listo!", tip: "No encontramos una página. Muestra la página entera, con buena luz y sin tu mano encima." }
```

- A review's `why` (staff's, or the run's `task/reply { verdict, why }`)
  that starts with a known code shows as that title and tip, with Retake.
  Anything else shows as written, as today.
- `task/history` resolves it, so Tasks and custom apps read the same words.
- Staff pick a reason from the type's list when they reject, so they stop
  typing codes.
- A `check` refusal (the automatic check before acceptance) reads "Almost
  there" with its reason, not as an error, and is labelled as the automatic
  check, apart from the team's review.

One optional column on `task_types`, added the way `ADDED` adds columns today.
`task/set-type` and the staff type editor take it.

## Order

| Step | Scope | Done when |
| --- | --- | --- |
| 1 | `payeeEarned`, `levels.ts`, `xp` on `task/me` (built) | `task/me` returns the level, tested in both stores |
| 2 | Tasks home card (built: card A), account widget level | A worker sees their level in Tasks and in any app |
| 3 | `LevelBadge` and `XpGain` in strut/views | A custom app can show "+50 XP" after a submit |
| 4 | `reasons` on the type, history resolves it, staff reason chips, check refusal screen | A rejected page reads as a tip with Retake |

Later, if wanted: missions (sets of N accepted), badges, unlocking a harder
type by earnings and OK rate, and acceptance metrics on `/tasks/numbers`.

## Not doing

- An XP table or event stream.
- Leaderboards between workers.
- Streaks, lives, random rewards, money prizes.
- Any change to pay amounts or payout rules.
