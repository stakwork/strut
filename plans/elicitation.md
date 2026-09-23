# Elicitation — the builder asks the user, and secrets never touch a model

> **Status (2026-09-22): proposed.** Shapes follow the ACP elicitation RFD
> (https://agentclientprotocol.com/rfds/elicitation), itself adapted from
> MCP's locked 2026-07-28 release candidate. We copy its field names and its
> secret rule; what we add is the transport, because strut's chat is a
> detached job with no connection to hold a request open on.
>
> **Revised after review (same day):** answers are stamped with who answered,
> never checked against the chat's actor (the store is deployment-global);
> answers go through the notifier's queue, so a form never sees a 409; the
> callback's `text` carries the question when a turn ends on an ask.

## Problem

Many workflows do nothing useful until a credential exists. Today the builder
calls `list_secrets`, sees the name is missing, and writes "please add
`SLACK_BOT_TOKEN` in the Secrets dialog". That is a dead end in three ways:

- The user has to find the dialog, type the name exactly, come back, and say
  "done" to restart the conversation.
- A user who doesn't know better **pastes the key into the chat**. It then
  lives in `messages.jsonl`, is re-fed to the model every turn, and may be
  forwarded to a host (Hive's canvas agent, another LLM) by the turn callback.
- When a host drives the chat (Hive's `dispatch_strut`), there is no dialog at
  all. The only channel back to a human is the host's own agent, which must
  never see the value.

Choice and free-text questions have a smaller version of the same problem:
the model can ask in prose, but the answer comes back unstructured, and a
host can't render it as anything but text.

## Decided

| Question | Decision |
| --- | --- |
| Shapes | **ACP's.** `mode: "form" \| "url"`, `message`, `requestedSchema` (restricted flat JSON Schema), `action: "accept" \| "decline" \| "cancel"`, `content`, `elicitationId`. No homemade question kinds |
| Secrets | **Never form mode** (ACP: MUST NOT). A secret is a URL-mode elicitation: the value is typed into a strut page that writes the secret store directly. The model, the transcript, the events log and the callback carry the NAME only |
| Who builds the URL | **The server**, never the model. `request_secret({ name, reason })` takes no URL, so the model cannot send a user to an arbitrary address |
| Transport | **The tool returns at once; the answer arrives as the next turn's user message.** No dangling tool call, no transcript surgery. `stopWhen: hasToolCall(…)` ends the turn after the ask; the answer goes through the notifier's queue, like a run notification, so it never collides with a live turn |
| Pending state | **One open elicitation per chat**, on `ChatMeta` — persisted, so it survives a restart. A new ask replaces it; a human message closes it |
| Who answered | **Recorded, never enforced.** The request's actor is stamped on the response; it is not compared with the chat's. The secret store is deployment-global, so a per-chat gate would guard one door beside an open one — and lock out the right person on a string mismatch. The binding is the deployment's auth, as for `PUT /secrets` |
| Hosts | **Carried on the turn callback.** Form questions go to the host (its agent or its UI). Secret questions are a link the host shows its user; the value never passes through the host. When a turn ends on an ask, the callback's `text` is the question, so a host that only reads text still sees it |

## Design in one paragraph

Two chat tools. `ask_user({ message, requestedSchema })` is ACP form mode;
`request_secret({ name, reason })` is URL mode for one secret. Each checks its
arguments, writes `ChatMeta.elicitation` (the open request, with a fresh
`elicitationId`), and returns `{ elicitationId, status: "asked" }`. The agent's
`stopWhen` includes `hasToolCall("ask_user", "request_secret")`, so the turn
ends right there, a complete tool call with its result. The turn callback
reports the open elicitation to a host. The answer comes back through one of
two endpoints: a form answer through `POST /chat/:id/elicitations/:eid`, a
secret through `POST /chat/:id/elicitations/:eid/secret`, which writes the
store itself. Either way the server clears the pending record and hands a
user-role `[elicitation-response]` message (for a secret: the name and
"stored", never the value) to the notifier's `deliver`, which launches the
next turn — or, when a turn is live, queues it behind that turn — exactly as
a `[run-notification]` arrives.

## Shapes

### The tools

```ts
ask_user({
  message: string,                     // shown above the form
  requestedSchema: {                   // ACP's restricted subset: flat object, primitives only
    type: "object",
    properties: Record<string, PrimitiveSchema>,
    required?: string[],
  },
}) → { elicitationId, status: "asked" }

request_secret({
  name: string,                        // the secret-store NAME, e.g. "SLACK_BOT_TOKEN"
  reason: string,                      // why the workflow needs it; shown to the user
}) → { elicitationId, status: "asked", url }
```

`PrimitiveSchema` is exactly the RFD's list:

- `string`: `title`, `description`, `minLength`, `maxLength`, `pattern`,
  `format` (`email | uri | date | date-time`), `default`.
- `number` / `integer`: `minimum`, `maximum`, `default`.
- `boolean`: `default`.
- Single select: `string` with `enum`, or `oneOf: [{ const, title }]`.
- Multi select: `array` whose `items` is an `enum` (or `anyOf` of
  `{ const, title }`), with `minItems` / `maxItems`.

Checked by a small hand-written validator (`src/ai/elicitation.ts`), used
twice: on the model's schema when the tool runs (anything outside the subset
is a tool error naming the offending property), and on the submitted
`content` when an answer arrives (a 400 names the field). Flat and primitive,
so the validator is a switch on `type`, not a JSON Schema engine.

**Guard against secrets in a form.** `ask_user` refuses a schema whose
property names or titles match `/password|secret|token|api[_ -]?key|private[_ -]?key|credential/i`,
with an error that says to use `request_secret`. It is a heuristic backing
up the prompt rule, not a guarantee; the prompt carries the ACP sentence.

`request_secret` refuses when strut does not own the secret store (the host
injected `services.secrets`; the `/secrets` endpoints return 501). The model
then falls back to telling the user in prose, as today.

### Pending record

```ts
// ChatMeta
elicitation?: {
  elicitationId: string;            // crypto-random (16 bytes, base64url) — see "Endpoints"
  toolCallId: string;               // ACP's scope binding: sessionId (the chat) + toolCallId
  turn: number;                     // the turn that asked
  createdAt: string;
} & (
  | { mode: "form"; message: string; requestedSchema: object }
  | { mode: "url"; message: string; name: string; url: string; exists: boolean }
);
```

`exists` says the name is already in the store, so the form reads "replace
`SLACK_BOT_TOKEN`?" rather than "add". It is computed from
`secretStore.list()` when the tool runs.

`url` is RELATIVE: `?chat=<chatId>&elicit=<elicitationId>`. Strut does not
know its public address (in Hive it is mounted under the lab's `/lab`), so a
host resolves the URL against the base it already dispatches to.

### Endpoints

Both are behind `requireApiKey`, like `PUT /secrets/:name`.

- **`POST /chat/:id/elicitations/:eid`** `{ action, content? }` — answers a
  form elicitation. `content` is validated against the stored schema, and is
  required only for `accept`. A secret elicitation can also be answered here
  with `decline` / `cancel` (never `accept`: that has to come through the
  secret endpoint).
- **`POST /chat/:id/elicitations/:eid/secret`** `{ value }` — URL mode's
  completion. It writes `secretStore.set(<name from the pending record>, value)`.
  The name is taken from the server's record, never from the request, so the
  page can't be pointed at a different secret. This is ACP's
  `elicitation/complete`, done by the server itself.

Both endpoints return **404** when `:eid` is not the chat's open elicitation
(already answered, replaced, or closed). On success they clear
`ChatMeta.elicitation` and hand the response message to the notifier's
`deliver` with a new `{ human: true }` option: `autoTurns` resets to 0 (a
person answered, so a parked chat wakes) and the turn launches with trigger
`human`. If a turn is live — a run notification woke the chat while the form
was on screen — the answer queues and drains into that turn's follow-up, the
way a notification that lands mid-turn does; a drain that includes an answer
launches as `human`. So there is **no 409** for an answer, and nothing is
factored out of `POST /chat` (which keeps its 409: a typed message is not a
queued answer). They reply 202 `{ chatId, turn? }` — `turn` when a turn
launched at once, absent when the answer queued; the flyout's idle poll
notices the turn either way.

**Who answered is recorded, never checked.** The request's actor
(`resolveActor`), when there is one, is stamped on the response message as
`by <actor>` — the model and the transcript see who answered, as a run
records who launched it. It is not compared with `meta.actor`. The secret
store is deployment-global (AGENTS.md "Secrets"): every member of the trust
domain can already write any name through `PUT /secrets/:name` and read any
name from a step they author, so a per-chat 403 would guard one door beside
an open one — and a string mismatch between a host's dispatch actor and its
login actor (plans/mothership-cost-control.md §2, "The actor string") would
lock the right person out of their own link. The binding is the deployment's
auth in front of the UI (mcp's JWT gate, or `STRUT_API_KEY`), exactly as for
`PUT /secrets`, plus the id: with the deployment key unset, the link IS the
authorization to write one named secret, so `elicitationId` is crypto-random
(16 bytes, base64url), never a counter or a timestamp. A real per-user check
arrives with per-user secrets, if ever.

### The response message

```
[elicitation-response] <elicitationId> accept by alice-42
{"repo":"stakwork/strut","branch":"main"}
```

```
[elicitation-response] <elicitationId> accept by alice-42 — secret SLACK_BOT_TOKEN stored (value not shown)
```

```
[elicitation-response] <elicitationId> decline
```

`by <actor>` is present when the request carried an actor. A user-role
message in the `[run-notification]` family: the model reads it as the answer
to the tool call it made, by id. The web flyout renders it as a
small notice card, not a user bubble (`web/src/notice.ts`, with a test that
runs the parser against the server's formatter, like the other notices).

### Turn callback

`TurnCallbackPayload` gains one field on `turn.end`:

```ts
elicitation?: { elicitationId, mode, message } &
  ({ requestedSchema } | { name, url })   // never a value
```

It is present when the turn ended with an elicitation open. `settled` does
not change meaning: nothing inside strut will wake the chat, so an open
elicitation is `settled: true`. The field tells the host why it is waiting.

**`text` is the question.** A turn that ends on an ask has no final answer —
`finalAssistantText` would return whatever the model said earlier in the
turn, or nothing. So when `elicitation` is present, `text` is rendered from
it: the `message`, then for a form one line per field (`repo (string,
required)`, `env: staging | production`), for a secret the name and reason.
A host that predates the field — or anything that only reads `text` — still
shows the question, and a prose reply through `POST /chat` closes the
elicitation and answers it. The feature degrades to "the builder asked",
never to silence.

## Lifecycle and edge cases

- **The model keeps talking after asking.** Prevented by `stopWhen`: the
  step that called the tool is the turn's last. The tool description also
  says "your turn ends here; the answer arrives as the next message".
- **The user types a message instead of answering.** `POST /chat` clears
  `ChatMeta.elicitation`, and the model sees the user's text. The form
  disappears. A late answer to the closed elicitation gets a 404.
- **The model asks again before an answer.** The new ask replaces the open
  one; the old id is dead. One open elicitation per chat keeps the UI and the
  callback to one thing. A second call in the same step replaces the first
  before the turn even ends; its result names the id it replaced, so the
  model knows which one is live.
- **A run or verify notification arrives while an elicitation is open.** It
  wakes the chat exactly as today. The elicitation stays open, and the model
  knows it asked. An answer submitted during that turn queues behind it and
  starts the follow-up turn (see "Endpoints"); the form never sees a 409. If
  the woken model asked again, the queued answer names a replaced id — the
  prompt says an answer to a replaced id is still the user's answer to that
  question.
- **Restart.** The pending record is on `meta.json`, so the form is still
  there after a restart and an answer still works. (Unlike the notifier's
  in-memory queue.)
- **`cancel` vs `decline`** are both passed to the model as they are. The
  prompt says: `decline` means don't ask again for this; `cancel` means the
  user dismissed it, and asking once more later is fine.

What never carries a secret value: the tool's arguments and result,
`messages.jsonl`, `events.jsonl`, `ChatMeta`, the turn callback, logs. The
only carrier is the body of the `/secret` request, which goes straight to
`secretStore.set`. A test asserts this by sending a sentinel value and
grepping every one of those files for it.

## UI (strut's web app)

- **Form mode.** `ChatFlyout` renders `meta.elicitation` below the last
  message: the `message`, the fields, and Submit / Decline, plus a close ✕
  that sends `cancel`. The flyout already polls `GET /chat/:id` while idle,
  so an elicitation opened by a notification-triggered turn appears without
  anything new. The fields map to the existing `ConfigField` renderer: a
  JSON-Schema → `FieldDesc` conversion next to `zodToFields`, since the
  subset lines up (string / number / boolean / enum / multi-enum).
- **URL mode.** Inside strut's own UI, "open the URL" just means opening the
  secret form: a password input, the name shown read-only, Save / Decline.
  It posts to the `/secret` endpoint, never to `/chat`. The same component
  opens when the app loads with `?chat=<id>&elicit=<eid>` (the link a host
  shows). That link opens the chat flyout on that chat, with the secret form
  on top.
- **Deep links.** `elicit` joins the params that `web/src/embed.ts` reports
  to an embedding host, so the host's URL stays in sync. The UI drops it once
  the elicitation is answered or closed, and on load ignores an `elicit` that
  is not `meta.elicitation.elicitationId` — a host reload with a stale param
  must not re-open a dead form.

## Hosts (Hive)

The Hive side is in the Hive repo; strut provides the callback field and the
link. What Hive does with them:

- **Form elicitations.** `fanOutStrutToCanvas` posts the question into the
  canvas conversation and wakes the canvas agent. The agent either answers
  from what it knows or asks its user, then replies through `dispatch_strut`
  with a new optional `answer: { elicitationId, action, content? }` (or a
  small `answer_strut` tool). Hive calls `POST /chat/:id/elicitations/:eid`.
  `answer` has no way to express a secret, so the canvas agent can't supply
  one even if it tries. Hive checks `elicitation` on the callback before it
  treats a `settled: true` turn as final; until it does, `text` carries the
  question (above), the canvas agent sees it as prose, and its prose reply
  through `dispatch_strut` closes the elicitation the ordinary way.
- **Secret elicitations.** The fan-out posts a card: "Strut needs
  `SLACK_BOT_TOKEN`: <reason>", showing the **full URL**
  (`<labBase>/?chat=…&elicit=…`) and an Open button. That is everything ACP
  asks of a URL-mode client: show the URL, open it only on the user's click.
  The user types the value into strut's page. Neither Hive's server nor
  either model sees it. The canvas agent hears "SLACK_BOT_TOKEN stored" on
  the next turn end.
- **Identity** comes from the lab sitting behind Hive's auth (mcp's JWT
  gate): only a signed-in member reaches the page, and mcp's `resolveActor`
  stamps that member on the response as `by`. Strut does not compare it with
  the chat's actor (see "Who answered" above), so Hive's dispatch actor and
  its JWT `sub` need not be the same string for the link to work.

A native Hive secret form is possible later (Hive server → strut's `/secret`
endpoint, server to server), but it would put Hive's server in the value's
path, and the link needs no Hive UI at all. Start with the link.

## Not doing (v1)

- **Arbitrary URL-mode elicitations** (OAuth connect flows, payments). The
  only URL-mode request is a strut secret page. OAuth stays the host's job
  (see "No OAuth" in AGENTS.md).
- **Elicitation from inside a workflow run** (a step pausing for a human).
  That is run control plus a human-in-the-loop step, a separate plan. This
  one is the builder chat only.
- **More than one open elicitation per chat,** and nested/object schemas.
  ACP's subset is flat; so is ours.
- **Speaking ACP on the wire.** The shapes match, so an ACP adapter over the
  chat is a thin mapping later, not a redesign.

## Steps

1. `src/ai/elicitation.ts`: the schema-subset validator (model schema +
   submitted content — content validation may lean on `z.fromJSONSchema`,
   zod 4.6, with `zodToFields` then serving the UI; the subset check stays
   hand-written either way), the secret-name heuristic, `newElicitationId()`
   (crypto-random), the `[elicitation-response]` formatter, and the
   callback `text` rendering of an open elicitation. Pure; unit-tested.
2. `ChatMeta.elicitation` in `chat-store.ts` (both impls). `POST /chat`
   clears it. Clearing is `setMeta({ elicitation: undefined })`: both stores
   spread the patch, so a test asserts the key reads as absent afterwards on
   both (JSON drops it on disk; the memory store keeps an `undefined` slot).
3. The two tools in `ai/tools.ts` (`AiDeps` gains `openElicitation(record)` —
   the chat id is in the per-turn closure, `toolCallId` comes from the tool's
   execute options — and the secret store's `list()` for `exists`). Add
   `hasToolCall("ask_user", "request_secret")` to the chat agent's `stopWhen`.
   Prompt: the ACP secret rule, "call `list_secrets` first; if the name is
   missing, `request_secret`", the decline/cancel meaning, and "an answer to
   a replaced id is still the answer".
4. `notifier.deliver(chatId, text, { human: true })` in `ai/notifier.ts`
   (reset `autoTurns`, launch as `human`; `startTurn` gains the trigger), then
   the two endpoints in `createStrut.ts` on top of it. Nothing is factored
   out of `POST /chat`.
5. `elicitation` on the turn callback payload; `text` is the rendered
   question when the turn ended on an ask.
6. Web: the form in `ChatFlyout` (JSON Schema → `FieldDesc`, plus a
   multi-select kind — `FieldDesc` has none today), the secret form,
   `?elicit=` handling (stale ids ignored, dropped once closed), `elicit` in
   `embed.ts`, the notice card.
7. The no-leak test: a sentinel secret through the whole flow, then grep the
   chat dir, the events, the callback bodies and captured logs.
8. AGENTS.md: a short "Elicitation" entry under Key concepts, and the tool
   list in the Layout table.
