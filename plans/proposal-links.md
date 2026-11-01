# Proposals as links: a tribe gets the title, an org member reads the card

> **Status (2026-11-01): proposed, design agreed in conversation.** Written
> after a read of strut `main` @c23756a (#404: the card on the record, a
> person token decides its own), hive `master` @57f0139f5 (Jamie in tribes:
> `src/lib/tribes/`, `src/lib/calls/callMessages.ts`,
> `src/services/strut-runs/orchestrator-turn.ts`) and peel `main` @1e25b45
> (#466: the tribe proposal cards). Companion to `proposals.md` (the
> record, the gate, decide) and `chained-orchestrators.md` §2 (the person
> token).

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
permissions question: three identity systems are involved, and none maps
onto another.

| System | Who it knows | What it can prove |
|---|---|---|
| The Sphinx tribe | aliases, the owner | nothing to Hive or strut: members are not verifiable outside the tribe server |
| The Hive org | its members | membership, to strut, as a **person token** Hive mints for each member's Peel (Stadeum pairing): `peer:person`, `sub` = the person's actor |
| strut | scopes: `full` (Hive, the API key), `peer:person`, `peer` | which actor a person token is for; nothing about orgs or tribes |

## Decided

| Question | Answer |
|---|---|
| Map tribe members to org members? | **No.** Each system answers only what it can prove. The tribe gets what is in the post; strut opens the record to person tokens; deciding stays where it is |
| Who sees that a proposal exists | **Anyone in the tribe**: the post's text, "Waiting for <linker> to approve: <title>" |
| Who reads the card and the input | **Any person token for the strut, for a proposal that was shared.** In a Hive org, that is its paired members. Strut does not know orgs: a shared proposal is open to every person this strut issued a token to |
| Who decides | **Unchanged.** The tribe's owner replies; Hive decides on strut as the linker (`src/app/api/tribes/messages/route.ts` checks the sender is the owner, as the person who linked). Peel's buttons stay with the owner (`tribe.canManage`), which mirrors that rule. A person token still decides only its own proposals (#404) |
| What marks a proposal shared | **Hive, when it writes the proposal into a conversation a tribe is linked to.** Posting to a room is what widens who sees it, and Hive is the one posting. One full-scope route, `POST /proposals/:id/share`. A proposal from a private Hive chat or a DM is never shared: its person alone reads it, as today |
| What the tribe post carries | **A stub**: `{ id, step, title, status, url }` per proposal beside the workspace (~150 bytes, one chunk). No card, summary or rationale. Decision posts are already this small |
| Where the card comes from | **The record on the org's strut**: `GET /proposals/:id`, read by Peel with its own person token for that workspace (`HivePeer.proposal`, which exists). The record has the input, so "Show the full input" works in a tribe |
| A reader who cannot read it | **Sees the title.** An unpaired member, a Peel paired to another org, a strut from before this: the post's text already says everything they may know |
| Lists | **Stay each person's own.** `GET /proposals` and `…/runs/:runId/proposals` answer "what waits on you"; a shared proposal opens by id only. (Peel also uses the list's other-people count to spot a strut from before #404.) |

### Considered, not taken

- **A secret read link in the post** (a capability token in the url): in a
  public tribe, or forwarded once, the card is anyone's, and the org
  strut's address goes to every member.
- **Hive serving the card** (a Hive route Peel reads): Hive becomes a
  content host for tribes with a permission model of its own; strut is the
  record and Peel already holds a token for it.
- **An audience on the launch** (`POST …/run { share: "org" }`, copied
  onto every proposal the run makes): decides before anything exists and
  adds a field every run carries, resumes and hands to its jobs; Hive
  already talks to the strut when it writes the rows.

## 1. strut

**The record** gains one field (`src/proposals.ts`):

```ts
/** Opened to every person token for this strut, by a full-scope request
 *  (`POST /proposals/:id/share`): what a host does when it posts the
 *  proposal where others read. One-way. */
shared?: { at: string; by?: string };
```

**The share route** (`createStrut.ts`, beside the others): `POST
/proposals/:id/share`, no body. Full scope only: the gate already refuses
a peer's POST that is not in its list, so nothing is added there. 404 with
no record; a shared one answers 200 unchanged (Hive may call it again); a
new share writes `shared: { at, by: <request actor> }` and answers the
record. Any status may be shared (a decided proposal is still worth
reading).

**Reading** (`visibleTo`): `full` reads everything; `peer:person` reads its
actor's own, and, by id only (`GET /proposals/:id`), a shared one; a plain
`peer` reads none. `GET /proposals` and `GET
/workflows/:name/runs/:runId/proposals` stay own-only. A record that is
not readable stays a 404, as now, so its existence is not told. The record
is served whole (input, rationale, decision, result): a proposal a host
shared was posted to a room, and its result is what the room will hear of
anyway.

**Deciding** is unchanged: `decideProposal` refuses a person token whose
actor is not the proposer's, shared or not.

`ProposalBrief` and `run.end` are unchanged: Hive still gets the whole
brief with the card for its canvas, over the full key.

## 2. The hosts

Strut alone changes nothing a tribe sees: the bytes leave the tribe when
Hive stops putting the card in the post, and the card comes back when
Peel reads the record. Order: strut, then Peel, then Hive. Peel first is
safe (a post that still carries a card draws it as today); Hive before
Peel leaves an older Peel drawing a card from the title alone
(`ProposalCard.generic`), which loses nothing it may show.

**Hive.**

- `orchestrator-turn.ts`, where the proposal rows are written
  (`orchestratorRowsFor`'s caller, right after it read `GET
  …/runs/<runId>/proposals` from the same strut): when the conversation is
  a tribe's thread (`TribeThread` by conversation id), `POST
  {lab}/proposals/:id/share` for each proposal with the org key. A failed
  share is logged and the row is written anyway; its readers get the
  title. Wake turns go through the same handler, so their proposals are
  shared the same way.
- `callMessages.ts` `proposalEnvelope`: the tribe's entry becomes `{ id,
  step, title, status, url }`. The row keeps the card (the canvas reads it,
  and `tribeDecisions.ts` reads its button words to match the owner's
  reply). Decision entries are already this size; cut `error` to one line.
- The same principle for deliverables: `strutReferenceEntries` keeps an
  entry that has both an address and inline `content`; drop the `content`
  in the tribe's envelope so a deliverable is only ever its link.

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
  direct decide on strut would not.

## 3. Not in this plan

- **Job files are wider than this.** Any person token reads every job's
  files on the org strut by job id (a peer scope reads every GET route),
  including a job started from someone's private conversation. After this
  plan a shared proposal is org-visible, matching what files already
  allow, while an unshared one stays its person's. Whether files should
  follow the same shared-or-not rule is its own question.
- **A job's own proposals in a tribe.** Only an orchestrator turn's
  proposals become rows and posts today. If Hive posts a job's later, it
  shares them the same way.
- **A proposal on another workspace's strut** (a build that ran on a
  peer): Peel reads it only when it holds a token for that workspace;
  otherwise the title.
- **Unsharing.** A post cannot be taken back from a tribe either.

## 4. Work items (strut)

One PR, `plans/proposal-links.md` its header.

1. `src/proposals.ts`: `shared` on the record, `shareProposal(root, id,
   by)`, `visibleTo` gains the by-id rule (a flag from the route, so the
   lists keep theirs); `proposals.test.ts`: a person reads another's
   shared proposal by id and not an unshared one, the list leaves both
   out, decide on a shared one is still 403 for another person, share is
   idempotent, a plain peer reads none.
2. `createStrut.ts`: `POST /proposals/:id/share`; the key and peer route
   sweeps in `createStrut.test.ts` cover it (full only).
3. Docs: `specs/API.md` §12 (the route, who reads what), `AGENTS.md`'s
   proposals paragraph, a line in `proposals.md`'s header pointing here.

## 5. Validation

- `npm test`.
- By hand, no host: `STRUT_WORKSPACE_BACKEND=ladybug npm run dev` with
  `STRUT_API_KEY` and `STRUT_PEER_KEY` set; two person tokens from `POST
  /peers/tokens` (actors `a`, `b`); a workflow with `agentTools` and
  `approve: [graph/create-node]` launched with `x-strut-actor: a`. `b`'s
  `GET /proposals/:id` is 404; share with the key; now 200 with the
  input; `b`'s `GET /proposals` does not list it; `b`'s decide is 403;
  `a`'s decide applies it.
- With Hive and Peel, on a swarm after the pin bump: in a linked tribe,
  `@jamie` proposes something. The post's metadata is the stub (one
  chunk in the bot's log). The owner's Peel shows the card with
  Accept/Reject and the full input; a member paired to the org sees the
  card without buttons; a member who is not paired sees "Waiting for
  <owner> to approve: <title>". The owner's "Accept" reply applies it and
  every reader sees the outcome.
