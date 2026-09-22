# Elicitation — the builder asks the user, and secrets never touch a model

> **Status (2026-09-22): proposed.** Shapes follow the ACP elicitation RFD
> (https://agentclientprotocol.com/rfds/elicitation), itself adapted from
> MCP's locked 2026-07-28 release candidate. We copy its field names and its
> secret rule; what we add is the transport, because strut's chat is a
> detached job with no connection to hold a request open on.

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
| Transport | **The tool returns at once; the answer arrives as the next turn's user message.** No dangling tool call, no transcript surgery. `stopWhen: hasToolCall(…)` ends the turn after the ask |
| Pending state | **One open elicitation per chat**, on `ChatMeta` — persisted, so it survives a restart. A new ask replaces it; a human message closes it |
| Hosts | **Carried on the turn callback.** Form questions go to the host (its agent or its UI). Secret questions are a link the host shows its user; the value never passes through the host |

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
store itself. Either way the server clears the pending record, appends a
user-role `[elicitation-response]` message (for a secret: the name and
"stored", never the value), and launches the next turn like `POST /chat` does.

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
  elicitationId: string;
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
(already answered, replaced, or closed), and **409** while a turn is live —
the same rule as `POST /chat`. On success they clear `ChatMeta.elicitation`,
append the response message, reset `autoTurns` (a person answered), and
launch the next turn with trigger `human`. They reply `{ chatId, turn }`
(202).

**Identity binding (ACP: state bound to the verified user).** When the
request has an actor (`resolveActor`) and the chat has one (`meta.actor`) and
they differ, the answer is a 403. Without actors this adds nothing; the
deployment's auth in front of the UI is the binding, as it is for
`PUT /secrets`.

### The response message

```
[elicitation-response] <elicitationId> accept
{"repo":"stakwork/strut","branch":"main"}
```

```
[elicitation-response] <elicitationId> accept — secret SLACK_BOT_TOKEN stored (value not shown)
```

```
[elicitation-response] <elicitationId> decline
```

A user-role message in the `[run-notification]` family: the model reads it
as the answer to the tool call it made, by id. The web flyout renders it as a
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

## Lifecycle and edge cases

- **The model keeps talking after asking.** Prevented by `stopWhen`: the
  step that called the tool is the turn's last. The tool description also
  says "your turn ends here; the answer arrives as the next message".
- **The user types a message instead of answering.** `POST /chat` clears
  `ChatMeta.elicitation`, and the model sees the user's text. The form
  disappears. A late answer to the closed elicitation gets a 404.
- **The model asks again before an answer.** The new ask replaces the open
  one; the old id is dead. One open elicitation per chat keeps the UI and the
  callback to one thing.
- **A run or verify notification arrives while an elicitation is open.** It
  wakes the chat exactly as today. The elicitation stays open, and the model
  knows it asked. Nothing needs queuing, because there is no dangling tool
  call to protect.
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
  to an embedding host, so the host's URL stays in sync.

## Hosts (Hive)

The Hive side is in the Hive repo; strut provides the callback field and the
link. What Hive does with them:

- **Form elicitations.** `fanOutStrutToCanvas` posts the question into the
  canvas conversation and wakes the canvas agent. The agent either answers
  from what it knows or asks its user, then replies through `dispatch_strut`
  with a new optional `answer: { elicitationId, action, content? }` (or a
  small `answer_strut` tool). Hive calls `POST /chat/:id/elicitations/:eid`.
  `answer` has no way to express a secret, so the canvas agent can't supply
  one even if it tries.
- **Secret elicitations.** The fan-out posts a card: "Strut needs
  `SLACK_BOT_TOKEN`: <reason>", showing the **full URL**
  (`<labBase>/?chat=…&elicit=…`) and an Open button. That is everything ACP
  asks of a URL-mode client: show the URL, open it only on the user's click.
  The user types the value into strut's page. Neither Hive's server nor
  either model sees it. The canvas agent hears "SLACK_BOT_TOKEN stored" on
  the next turn end.
- **Identity binding** comes from the lab sitting behind Hive's auth (mcp's
  JWT gate), plus the actor check above: the lab request carries the viewing
  user as its actor, and it must match the chat's.

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
   submitted content), the secret-name heuristic, and the
   `[elicitation-response]` formatter. Pure; unit-tested.
2. `ChatMeta.elicitation` in `chat-store.ts` (both impls). `POST /chat`
   clears it.
3. The two tools in `ai/tools.ts` (`AiDeps` gains `openElicitation(chatId,
   record)` and the secret store's `list()` for `exists`). Add
   `hasToolCall("ask_user", "request_secret")` to the chat agent's `stopWhen`.
   Prompt: the ACP secret rule, "call `list_secrets` first; if the name is
   missing, `request_secret`", and the decline/cancel meaning.
4. The two endpoints in `createStrut.ts`, sharing a `resumeWithMessage(chatId,
   text)` helper factored out of `POST /chat` (append the user message, reset
   `autoTurns`, launch the turn).
5. `elicitation` on the turn callback payload.
6. Web: the form in `ChatFlyout` (JSON Schema → `FieldDesc`), the secret form,
   `?elicit=` handling, `elicit` in `embed.ts`, the notice card.
7. The no-leak test: a sentinel secret through the whole flow, then grep the
   chat dir, the events, the callback bodies and captured logs.
8. AGENTS.md: a short "Elicitation" entry under Key concepts, and the tool
   list in the Layout table.
