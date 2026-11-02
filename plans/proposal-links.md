# Proposals as links: a tribe gets the title, an org member reads the card

> **Status (2026-11-01): proposed, design agreed in conversation; amended
> the same day after review.** Written after a read of strut `main`
> @c23756a (#404: the card on the record, a person token decides its own),
> hive `master` @57f0139f5 (Jamie in tribes: `src/lib/tribes/`,
> `src/lib/calls/callMessages.ts`, `src/services/strut-runs/orchestrator-turn.ts`,
> `src/services/strut-proposals.ts`), peel `main` @1e25b45 (#466: the tribe
> proposal cards) and sphinx `master` @d7160974 (`tribes/src/forward.rs`,
> `sphinx/src/msg/`). Companion to `proposals.md` (the record, the gate,
> decide) and `chained-orchestrators.md` §2 (the person token).
>
> **Amended:** the first draft marked a proposal `shared` before another
> person could read it, and asked who in a tribe may decide. Review found
> the flag guards nothing strut holds (§"Considered") and the owner ruled
> on identity: the canonical person is the **Hive member and their strut
> actor**; the tribe is a room. So: a person token reads any proposal on
> its strut by id, the decider is the proposal's own actor, and the tribe
> telling Jamie who is speaking is a second item (§3), built after this one.

## Problem

A Sphinx tribe should carry messages, and anything large should be a
link: deliverables already are (a strut entry with a strut-relative `url`,
opened by Peel through its own pairing). Proposals are not. Hive's post
"Waiting for Tom Smith to approve: <title>" carries the whole proposal in
`metadata.strut.proposals`: strut's card (up to 12 fields of 500 chars),
the summary and the model's rationale. That is ~10 KB, ~30 type-34 chunks
at a sat each, and a big card would hit the Jamie bot's 32 KB message cap
and be refused outright. The card also goes to everyone in the tribe,
members of the org or not.

The obvious fix (send a link, let Peel read the record) runs into a
permissions question: three identity systems are involved.

| System | Who it knows | What it can prove |
|---|---|---|
| The Sphinx tribe | aliases, the owner | nothing to Hive or strut: the tribe server rewrites every forwarded message (`forward.rs` `mutate_msg_to_forward`: the sender's pubkey becomes the tribe's, `contact_pubkey` is dropped, one `role` byte is set, `0` for the owner), re-signs it with the tribe key, and sends one copy to every member. Members and Jamie see an alias and that byte |
| The Hive org | its members | membership, to strut, as a **person token** Hive mints for each member's Peel (Stadeum pairing): `peer:person`, `sub` = the person's actor. The actor is a function of the Hive user (`resolveStrutActor`, `src/services/bifrost/strut-delegation.ts`), so **Hive member ↔ strut actor is already matched**. Hive also knows a member's Sphinx pubkey when they signed in or linked with Sphinx (`User.lightningPubkey`, unique, set from a signed challenge; stored encrypted) |
| strut | scopes: `full` (Hive, the API key), `peer:person`, `peer` | which actor a person token is for; nothing about orgs or tribes |

Two of the three hops exist: Hive member → strut actor, and Sphinx pubkey
→ Hive member. The missing one is **a tribe message → its sender's
pubkey**, which only the tribe server can supply. This plan does not need
it: the card is read where a credential already exists (the member's
Peel, against strut), and the decider is the person whose turn it was.
§3 is where the hop is built, so that each asker's turn runs on their own
resources.

## Decided

| Question | Answer |
|---|---|
| Who is a person, canonically | **The Hive member and their strut actor.** The tribe gives an alias and an owner bit, nothing a system can act on. Until the tribe server tells Jamie who is speaking (§3), every tribe turn runs as the **linker** (the tribe's owner, who linked it), and its proposals are the linker's |
| Who sees that a proposal exists | **Anyone in the tribe**: the post's text, "Waiting for <linker> to approve: <title>" |
| Who reads the card and the input | **Any person token for the strut, by id.** In a Hive org, that is its paired members. Nothing marks a proposal readable: a person token already reads every run's log on that strut (the gate passes every GET to a peer scope, `createStrut.ts` "the API key gate"; the run routes check neither scope nor sealed), and a gated call's `step.start` carries its whole input, rationale included (`agent.ts` `wrapToolsWithEmit`), with the proposal's id on its `step.end`. It reads every job's files the same way. The id is 72 random bits (`randomBytes(9)`), and the lists stay each person's own, so "by id" already means "someone showed it to you", as a job id does. One rule for files, jobs and proposals |
| Who decides | **The proposal's actor: whoever's resources the turn ran on.** The apply runs on `by.principal`'s secrets (`applyProposal`: `secrets.forPrincipal`), so another member approving would run a push on the proposer's token. Today every tribe turn is the linker's, so the linker decides: the tribe's owner replies, and Hive decides on strut as them (`decideStrutProposal`, the org key with `x-strut-actor`; `/api/tribes/messages` checks the sender is the owner). Peel's buttons stay with the owner (`tribe.canManage`), which mirrors that rule. Strut: #404's rule as it stands — a person token decides its own, full scope decides and Hive enforces the match. **No strut change.** With §3, each asker's proposals are theirs and Hive matches the replier to `by.actor` |
| What the tribe post carries | **A stub**: `{ id, step, title, status, url }` per proposal beside the workspace (~150 bytes, one chunk). No card, summary or rationale. Decision posts are already this small. The rule is strict and holds for deliverables too: a tribe envelope is references only, capped in bytes, and the daemon refuses anything larger (§2) |
| Where the card comes from | **The record on the org's strut**: `GET /proposals/:id`, read by Peel with its own person token for that workspace (`HivePeer.proposal`, which exists). The record has the input, so "Show the full input" works in a tribe |
| A reader who cannot read it | **Sees the title.** An unpaired member, a Peel paired to another org, a strut from before this: the post's text already says everything they may know |
| Lists | **Stay each person's own.** `GET /proposals` and `…/runs/:runId/proposals` answer "what waits on you"; another person's proposal opens by id only. (Peel also uses the list's other-people count to spot a strut from before #404.) |

### Considered, not taken

- **A `shared` flag on the record** (the first draft: `POST
  /proposals/:id/share`, Hive marking a proposal when it posts it to a
  tribe, `visibleTo` opening a shared one by id). It guards a boundary
  strut does not hold: the input and the id are in the run log any person
  token reads, so a "private DM proposal stays its person's" rule was
  already false; it is a second rule beside files and jobs; and it put a
  write with a silent failure mode (a failed share → members see a bare
  title) on Hive's turn handler. Dropped.
- **Any org member decides.** Hive's own card decides as the clicking
  member under the org key, which looked like the model to copy. But the
  apply spends the proposer's principal (their token, their delegation),
  so the decider must be the proposer. If an org ever wants "any member
  approves org-level writes", that is a run-level audience, its own plan.
- **A secret read link in the post** (a capability token in the url): in a
  public tribe, or forwarded once, the card is anyone's, and the org
  strut's address goes to every member.
- **Hive serving the card** (a Hive route Peel reads): Hive becomes a
  content host for tribes with a permission model of its own; strut is the
  record and Peel already holds a token for it.
- **An audience on the launch** (`POST …/run { share: "org" }`, copied
  onto every proposal the run makes): decides before anything exists and
  adds a field every run carries, resumes and hands to its jobs.

## 1. strut

One change. **Reading** (`visibleTo`, `src/proposals.ts`): `full` reads
everything; `peer:person` reads its actor's own in the lists and, by id
(`GET /proposals/:id`), any proposal on this strut; a plain `peer` reads
none. The route passes a flag, so `GET /proposals` and `GET
/workflows/:name/runs/:runId/proposals` keep the own-only rule. A record
is served whole (input, rationale, decision, result): a line for the
hosts, since `result.output` may be as large as a step output (8 MB) and
Peel caps a read at 4 MB — today's gated steps return small outputs.

**Deciding** is unchanged: `decideProposal` refuses a person token whose
actor is not the proposer's. No new field, no new route. `ProposalBrief`
and `run.end` are unchanged: Hive still gets the whole brief with the card
for its canvas, over the full key.

## 2. The hosts

Strut alone changes nothing a tribe sees: the bytes leave the tribe when
Hive stops putting the card in the post, and the card comes back when
Peel reads the record. **No ship order between Hive and Peel.** Peel is a
desktop app, updated on each person's own schedule, so every Hive post must
read on every Peel version: a Peel from before this draws a stub as a
title-only card with the owner's buttons (`ProposalCard.generic`; its reply
words match Hive's plain accept / reject), never reads the strut for a
post-backed proposal, and the outcome posts still move it — it loses
nothing it may show. A Peel with a card-bearing post from an older Hive
draws it as today. The one dependency is strut on the swarms (the mcp pin
bump) before a new Peel reads by id, and even that degrades to "not
readable here".

**Hive.**

- **The rule, strict: nothing large rides in a Sphinx message; a tribe
  envelope carries references only.** `metadata.strut` is `{ workspace,
  artifacts: [{ id, kind, title, url | app | path }], proposals: [{ id, step,
  title, status, url }] }` and nothing else — never `content`, `card`,
  `summary` or `rationale`, whatever the entry holds beside its address. A
  `path` is an address too (a job's file), and a peer's entry keeps the tags
  Peel opens it by (`peer`, `via`, `job`): a build on another strut has no
  `url` of its own.
  Today `strutReferenceEntries` keeps a whole entry once it has an
  address, so a deliverable with both a `url` and inline `content` ships
  the content, and the proposal entry ships the card. The text already
  has a cap (`MAX_TRIBE_TEXT_CHARS`, 4 000); the envelope gets one too,
  `MAX_TRIBE_METADATA_BYTES`, proposed 2 KB (about six chunks), entries
  past it dropped and the conversation link in the text standing for
  them. A proposal can be very large (12 fields of 500 chars, a long
  `summary`), so the rule is on the SHAPE, not a size check of the card.
- `callMessages.ts` `proposalEnvelope`: the stub. The row keeps the card
  (the canvas reads it, and `tribeDecisions.ts` reads its button words to
  match the owner's reply). Decision entries are already this size; cut
  `error` to one line.
- **Enforced at the sender, not only shaped in Hive.** The daemon
  (`wasm/daemon`, Jamie's sphinx-chat account) refuses to post `metadata`
  over the same cap: the text goes, the metadata does not, the refusal is
  logged — so no later Hive change can put a card back into a tribe.
  sphinx-chat's 32 KB `MAX_SEND_BYTES` is a transport limit, not this
  rule. Peel sends no metadata into a tribe today (`sendText(metadata:)`
  is the CLI's path; `sendControl` is a DM); its tribe send gains the
  same guard, so the rule holds when its own agent posts there.
- Deciding by reply stays as it is: the owner's reply decides, as the
  linker, whom every tribe turn runs as. When §3 lands, a mention that
  carries an identified sender decides only a proposal whose `by.actor`
  is that person's actor; anyone else is told whose it is. **If no sender
  is sent, the turn — and so the proposal — is the owner's**, as today.
- No share call. Nothing on the turn handler changes.

**Peel.**

- A tribe proposal entry with no card: if a Stadeum peer matches the
  envelope's `workspace`, read `GET /proposals/:id` with it
  (`HivePeer.proposal`) and draw the record's card, input included. Keep
  the read on the kept proposal (`ProposalWatch`), and read again when
  the card is opened and when a decision post arrives.
- **In a tribe, a 404 means "not readable here", never "gone".** Today a
  404 finishes the proposal as gone (`Proposals.swift`, `.gone`); from a
  stub it must leave the card at the title, waiting. 403 the same.
- No matching peer, or the read fails: the title and status from the
  stub, the card body shut and saying it opens for the org's members.
- A post that carries a card (an older Hive) draws it as today.
- Buttons stay with the tribe's owner (`canAnswer: tribe.canManage`), and
  the answer stays a reply: Hive posts the outcome to the tribe, which a
  direct decide on strut would not. With §3, buttons for a member whose
  pairing is the proposal's actor.

## 3. Item two: the tribe tells Jamie who is speaking (later, sphinx)

Not part of this plan's PRs. Needed so that each asker's turn runs on
their own resources — their GitHub token (actor secrets), their
delegation — and so their proposals are theirs. Its own plan belongs in
the sphinx repo beside `docs/sovereign-tribes.md`; hive's
`docs/plans/jamie-in-tribes.md` open question 6 points at it. What was
settled here, so the two items fit:

- **The server tells the bot, and only the bot.** When the owner has
  granted it (a tribe command), the tribe server puts the sender's pubkey
  in `contact_pubkey` on the copy sent to Jamie's member record. The key
  already exists and every client parses it (`ser.rs` `deserialize_sender`
  refuses an unknown key as `bad key`, so a NEW key would break every old
  client); the room's copies are unchanged, so the server's anonymity
  property holds; the cost is a second signature in the fan-out. The
  daemon passes `sender` to Hive's messages route.
- **Hive** maps pubkey → `User.lightningPubkey` → `resolveStrutActor` and
  launches the turn as that actor with their delegation ensured; decides
  by reply as the identified replier, matched to the proposal's actor.
  The lookup is a decrypt-and-compare scan today, so it needs a hashed
  column. An unidentified sender (no pubkey, or one no member holds) runs
  as the linker, as now.
- **Peel** registers its Sphinx pubkey with Hive at pairing (a signature),
  so a paired Peel user is identified without a settings step; grants
  Jamie the sender view as part of linking; shows buttons to the member
  whose pairing is the proposal's actor.
- Considered: a signed member list bound by alias (`ListMembers` exists;
  the server keeps aliases unique per tribe at forward time, but a change
  between list and message misattributes — a fallback for servers not yet
  upgraded); Peel signing its own mentions (Peel users only, bytes to
  every reader).

## 4. Not in this plan

- **Job files are wider than this.** Any person token reads every job's
  files on the org strut by job id (a peer scope reads every GET route),
  including a job started from someone's private conversation. After this
  plan a proposal is readable the same way, by id. Whether a run's log,
  files and proposals should ever carry an audience is its own question.
- **A job's own proposals in a tribe.** Only an orchestrator turn's
  proposals become rows and posts today. If Hive posts a job's later, it
  posts them the same way.
- **A proposal on another workspace's strut** (a build that ran on a
  peer): Peel reads it only when it holds a token for that workspace;
  otherwise the title.

## 5. Work items (strut)

One PR, `plans/proposal-links.md` its header.

1. `src/proposals.ts`: `visibleTo` gains the by-id rule (a flag from the
   route, so the lists keep theirs); `proposals.test.ts`: a person reads
   another's proposal by id, the list leaves it out, decide on it is
   still 403 for another person, a plain peer reads none by id.
2. `createStrut.ts`: `GET /proposals/:id` passes the flag; the key and
   peer route sweeps in `createStrut.test.ts` are unchanged.
3. Docs: `specs/API.md` §12 (who reads what), `AGENTS.md`'s proposals
   paragraph, a line in `proposals.md`'s header pointing here.

## 6. Validation

- `npm test`.
- By hand, no host: `STRUT_WORKSPACE_BACKEND=ladybug npm run dev` with
  `STRUT_API_KEY` and `STRUT_PEER_KEY` set; two person tokens from `POST
  /peers/tokens` (actors `a`, `b`); a workflow with `agentTools` and
  `approve: [graph/create-node]` launched with `x-strut-actor: a`. `b`'s
  `GET /proposals/:id` is 200 with the input; `b`'s `GET /proposals` does
  not list it; `b`'s decide is 403; `a`'s decide applies it; the plain
  peer key's `GET /proposals/:id` is 404.
- With Hive and Peel, on a swarm after the pin bump: in a linked tribe,
  `@jamie` proposes something. The post's metadata is the stub (one
  chunk in the bot's log). The owner's Peel shows the card with
  Accept/Reject and the full input; a member paired to the org sees the
  card without buttons; a member who is not paired sees "Waiting for
  <owner> to approve: <title>". The owner's "Accept" reply applies it and
  every reader sees the outcome.
