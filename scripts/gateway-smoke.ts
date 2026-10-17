/**
 * End-to-end: strut → Mothership → stakgraph-gateway (Bifrost) → provider,
 * against `docker compose -f docker-compose.yml -f docker-compose.gateway.yml
 * up`. strut there holds NO provider keys, so everything passing here went
 * through the gateway. Opt-in: `STRUT_TEST_GATEWAY=1 npm run test:gateway`.
 *
 * Checks: (a) an Anthropic chat turn that calls web_fetch, (a2) one that
 * calls web_search and then another tool — so the model's NEXT request
 * carries the search in its history, (b) a workflow run with an agent step
 * (web_fetch + bash) and an llm step, (b2) two runs on one agent `session` —
 * the second request replays the first turn's search, tool calls and
 * thinking through the gateway (plans/agent-sessions.md), (b3) a session that
 * changes provider (anthropic → xai → anthropic), xai naming the colour of an
 * image a tool returned on the Anthropic turn, (e) an agent run
 * that compacts (plans/compaction.md; the overlay's STRUT_COMPACT_AT), (c) an
 * xai chat turn (OpenAI-compatible route), (d) the gateway's log has the calls
 * under their session dims (the workflow name, the chat id).
 *
 * Routed through a gateway, strut never uses Anthropic's server-executed web
 * tools (`createWebTools({ routed })` → aieo's Exa + HTTP shims), because
 * Bifrost cannot re-render their `server_tool_use` blocks faithfully — so
 * this passes on every gateway build. To probe a gateway's handling of the
 * native tools directly, without strut in the way: scripts/gateway-stream.mts
 * (`webfetch` dies on a v1.6.2 build, `websearch-tool` on v2.2.2 and upstream
 * latest).
 *
 * Env: STRUT_URL (http://localhost:3000), GATEWAY_URL (http://localhost:8181,
 * as this script sees it), GATEWAY_INNER_URL (http://gateway:8181, as strut
 * sees it — what the delegation records), STRUT_API_KEY (strut-dev-key),
 * BIFROST_ADMIN_USER/PASS (admin / bifrost-dev-password),
 * STRUT_TEST_GATEWAY_MODEL (claude-sonnet-5), STRUT_TEST_GATEWAY_XAI_MODEL
 * (xai/grok-4.7; "off" skips c). (a2) needs EXA_API_KEY in ./.env — the
 * compose overlay hands it to strut.
 */
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { mintDelegation } from "../src/test-util/mint-delegation.js";

if (process.env["STRUT_TEST_GATEWAY"] !== "1") {
  console.log("gateway smoke skipped (set STRUT_TEST_GATEWAY=1; see docker-compose.gateway.yml)");
  process.exit(0);
}

const env = (k: string, d: string) => process.env[k] || d;
const STRUT = env("STRUT_URL", "http://localhost:3000");
const GATEWAY = env("GATEWAY_URL", "http://localhost:8181");
const GATEWAY_INNER = env("GATEWAY_INNER_URL", "http://gateway:8181");
const KEY = env("STRUT_API_KEY", "strut-dev-key");
const ADMIN = "Basic " + Buffer.from(`${env("BIFROST_ADMIN_USER", "admin")}:${env("BIFROST_ADMIN_PASS", "bifrost-dev-password")}`).toString("base64");
const MODEL = env("STRUT_TEST_GATEWAY_MODEL", "claude-sonnet-5");
const XAI_MODEL = env("STRUT_TEST_GATEWAY_XAI_MODEL", "xai/grok-4.7");

const tag = Date.now().toString(36);
const ACTOR = `smoke-${tag}`;
const WORKFLOW = `gateway-smoke-${tag}`;
const strutHeaders = { authorization: `Bearer ${KEY}`, "x-strut-actor": ACTOR, "content-type": "application/json" };

type Ev = Record<string, any>;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

async function waitFor(url: string, ok: (status: number) => boolean, what: string) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const status = await fetch(url).then((r) => r.status, () => 0);
    if (ok(status)) return;
    if (Date.now() > deadline) throw new Error(`${what} not up at ${url} (last status ${status})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function json(res: Response, what: string) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Every `data:` event of an SSE stream until it closes (the `done` event included). */
async function sse(url: string): Promise<Ev[]> {
  const res = await fetch(url, { headers: strutHeaders, signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  const events: Ev[] = [];
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) events.push(JSON.parse(data));
    }
  }
  return events;
}

/** One chat turn to its end; returns the turn's events. */
async function chatTurn(model: string, message: string) {
  const { chatId, turn } = await json(
    await fetch(`${STRUT}/chat`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ model, message }) }),
    `POST /chat (${model})`,
  );
  return { chatId: chatId as string, events: await sse(`${STRUT}/chat/${chatId}/stream?turn=${turn}`) };
}

/** A `size`×`size` PNG of one colour, base64 — a picture only a model that
 *  SEES it can describe. */
function solidPng(size: number, [r, g, b]: [number, number, number]): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const errorsOf = (events: Ev[]) =>
  events
    .filter((e) => e.type === "chat.error" || e.type === "run.error" || e.type === "step.error" || e.status === "error")
    .map((e) => JSON.stringify(e.error ?? e));

// ── setup ──────────────────────────────────────────────────────────────────

await waitFor(`${GATEWAY}/v1/models`, (s) => s === 200 || s === 401, "gateway");
await waitFor(`${STRUT}/health`, (s) => s === 200, "strut");

const vk = await json(
  await fetch(`${GATEWAY}/api/governance/virtual-keys`, {
    method: "POST",
    headers: { authorization: ADMIN, "content-type": "application/json" },
    // Deny-by-default: a provider entry needs BOTH key_ids and allowed_models.
    // Only providers that don't serve each other's models: governance
    // load-balances a model across every allowed provider that has it (by
    // weight), so allowing openrouter too sends ~half the claude calls there,
    // where the native web_fetch tool is silently dropped.
    body: JSON.stringify({
      name: `strut-smoke-${tag}`,
      provider_configs: ["anthropic", "xai"].map((provider) => ({
        provider,
        weight: 1,
        key_ids: ["*"],
        allowed_models: ["*"],
      })),
    }),
  }),
  "create virtual key",
);
const vkValue: string = vk?.virtual_key?.value ?? vk?.value;
if (!vkValue) throw new Error(`no VK value in ${JSON.stringify(vk)}`);

// The gateway ships enforce_macaroons: false (shadow mode), so a macaroon
// signed by a throwaway org key verifies-and-warns, never rejects.
const orgPriv = randomBytes(32);
orgPriv[0] = 1;
const d = mintDelegation({ actor: ACTOR, orgPriv, userPriv: randomBytes(32) });
await json(
  await fetch(`${STRUT}/llm/delegations/${encodeURIComponent(ACTOR)}`, {
    method: "PUT",
    headers: strutHeaders,
    body: JSON.stringify({ macaroon: d.macaroon, apiKey: vkValue, baseUrl: GATEWAY_INNER }),
  }),
  "PUT delegation",
);
console.log(`actor ${ACTOR}, workflow ${WORKFLOW}, gateway ${GATEWAY_INNER} (from strut)`);

const FETCH_PROMPT =
  "Use your web_fetch tool on https://example.com/ (do not guess, do not use any other tool) and reply with the page's <title> text only.";

// ── (a) anthropic chat turn with web_fetch (routed: aieo's HTTP shim) ──────

const a = await chatTurn(MODEL, FETCH_PROMPT);
{
  const errs = errorsOf(a.events);
  check("(a) anthropic chat: web_fetch called", a.events.some((e) => e.type === "tool-input" && e.toolName === "web_fetch"));
  check("(a) anthropic chat: ends with chat.end, no chat.error", a.events.some((e) => e.type === "chat.end") && !errs.length, errs.join(" | "));
}

// ── (a2) anthropic chat: web_search, then another tool ─────────────────────
// The swarm38 turn of 2026-09-24: with Anthropic's native web_search the
// model's NEXT request carries the search as a `server_tool_use` block, which
// the gateway re-renders WITHOUT its `input` → 400 `server_tool_use.input:
// Field required`, chat.error. Routed, strut offers the Exa shim instead — a
// plain tool call the gateway forwards untouched.

const a2 = await chatTurn(
  MODEL,
  "Use your web_search tool to find the capital of Australia. Then call your list_steps tool once. Then reply with the city in one word.",
);
{
  const errs = errorsOf(a2.events);
  check("(a2) anthropic chat: web_search called (needs EXA_API_KEY in ./.env)", a2.events.some((e) => e.type === "tool-input" && e.toolName === "web_search"));
  check("(a2) anthropic chat: a tool call after the search", a2.events.some((e) => e.type === "tool-input" && e.toolName === "list_steps"));
  check("(a2) anthropic chat: ends with chat.end, no chat.error", a2.events.some((e) => e.type === "chat.end") && !errs.length, errs.join(" | "));
}

// ── (b) workflow: agent (web_fetch + bash) → llm ───────────────────────────

const yaml = `name: ${WORKFLOW}
steps:
  - id: research
    type: agent
    config:
      cwd: /tmp
      model: ${MODEL}
      toolFilter: [web_fetch, bash]
      maxSteps: 8
      system: You are a terse test agent. Use exactly the tools you are told to.
      prompt: >-
        First run the bash command \`echo strut-smoke-ok\`. Then use web_fetch on
        https://example.com/ and answer with the page's <title> text only.
  - id: summarize
    type: llm
    config:
      model: ${MODEL}
      prompt: "Repeat this title verbatim and nothing else: {{ research.result }}"
`;
await json(await fetch(`${STRUT}/workflows`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ name: WORKFLOW, yaml }) }), "publish workflow");
const { runId } = await json(
  await fetch(`${STRUT}/workflows/${WORKFLOW}/run`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ input: {} }) }),
  "launch run",
);
const b = await sse(`${STRUT}/workflows/${WORKFLOW}/runs/${runId}/stream`);
{
  const end = b.find((e) => e.type === "step.end" && e.path === `${WORKFLOW}/research`);
  const result = String(end?.output?.result ?? "");
  const errs = errorsOf(b);
  check("(b) run: run.end, no errors", b.some((e) => e.type === "run.end") && !errs.length, errs.join(" | "));
  check("(b) run: agent's tool:bash step event", b.some((e) => e.type === "step.end" && e.stepType === "tool:bash"));
  // Routed, web_fetch is aieo's HTTP shim — a client tool, so it gets a
  // tool:* run event like bash (Anthropic's own would not: no `execute`).
  check("(b) run: agent's tool:web_fetch step event", b.some((e) => e.type === "step.end" && e.stepType === "tool:web_fetch"));
  check("(b) run: agent fetched the page", /example domain/i.test(result), JSON.stringify(result).slice(0, 120));
  const llm = b.find((e) => e.type === "step.end" && e.path === `${WORKFLOW}/summarize`);
  check("(b) run: llm step answered", /example domain/i.test(String(llm?.output?.text ?? "")));
}

// ── (b2) an agent session: the second run continues the first ─────────────
//
// Turn 1's first request carries turn 0 — a web search, a bash call, the
// model's thinking — read back from the session store, through the gateway.

{
  const name = `${WORKFLOW}-session`;
  const session = `smoke/${tag}`;
  const marker = `strut-session-${tag}`;
  const sessionYaml = `name: ${name}
input:
  prompt: { type: string }
  session: { type: string }
steps:
  - id: work
    type: agent
    config:
      cwd: /tmp
      model: ${MODEL}
      session: "{{ input.session }}"
      toolFilter: [web_search, bash]
      maxSteps: 8
      system: You are a terse test agent. Use exactly the tools you are told to.
      prompt: "{{ input.prompt }}"
`;
  await json(await fetch(`${STRUT}/workflows`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ name, yaml: sessionYaml }) }), "publish session workflow");
  const turn = async (prompt: string) => {
    const launched = await json(
      await fetch(`${STRUT}/workflows/${name}/run`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ input: { prompt, session } }) }),
      "launch session run",
    );
    const events = await sse(`${STRUT}/workflows/${name}/runs/${launched.runId}/stream`);
    return { events, end: events.find((e) => e.type === "step.end" && e.path === `${name}/work`) };
  };
  const t0 = await turn(
    `Use web_search to find the year the Eiffel Tower opened. Then run the bash command \`echo ${marker}\`. Answer with the year only.`,
  );
  let errs = errorsOf(t0.events);
  check("(b2) session turn 0: run.end, no errors", t0.events.some((e) => e.type === "run.end") && !errs.length, errs.join(" | "));
  check("(b2) session turn 0: searched, then ran bash", ["tool:web_search", "tool:bash"].every((t) => t0.events.some((e) => e.type === "step.end" && e.stepType === t)));
  check("(b2) session turn 0: is turn 0", t0.end?.output?.session?.turn === 0, JSON.stringify(t0.end?.output?.session));

  const t1 = await turn("Without using any tool: which bash command did you run earlier? Answer with the command only.");
  errs = errorsOf(t1.events);
  check("(b2) session turn 1: run.end, no errors", t1.events.some((e) => e.type === "run.end") && !errs.length, errs.join(" | "));
  check("(b2) session turn 1: is turn 1", t1.end?.output?.session?.turn === 1, JSON.stringify(t1.end?.output?.session));
  check("(b2) session turn 1: remembers turn 0", String(t1.end?.output?.result ?? "").includes(marker), JSON.stringify(t1.end?.output?.result).slice(0, 160));
  check("(b2) session turn 1: read the prefix from the cache", (t1.end?.output?.usage?.cacheReadTokens ?? 0) > 0, JSON.stringify(t1.end?.output?.usage));
}

// ── (b3) a session that changes provider: anthropic → xai → anthropic ─────
//
// The swarm38 job of 2026-10-17: a thread begun on Anthropic, a turn on
// grok. Turn 0 calls a tool that returns a colour swatch (`withMedia`) and
// does not name the colour; turn 1, on xai, must name it from the image —
// which reaches grok only if the tool result's image was moved to a user
// message (`moveToolResultImages`: the `openai.chat` route would send it as
// base64 text). Turn 2 goes back to Anthropic over xai's turn.

if (XAI_MODEL !== "off") {
  const name = `${WORKFLOW}-switch`;
  const session = `smoke/${tag}-switch`;
  await json(
    await fetch(`${STRUT}/steps`, {
      method: "POST",
      headers: strutHeaders,
      body: JSON.stringify({
        name: "smoke/swatch",
        code: `import { z, defineStep, withMedia } from "strut";
export default defineStep({
  type: "smoke/swatch",
  description: "Show the swatch.",
  input: z.object({}),
  output: z.any(),
  async run() {
    return withMedia({ swatch: "swatch.png" }, [{ mediaType: "image/png", data: ${JSON.stringify(solidPng(64, [220, 20, 20]))} }]);
  },
});
`,
      }),
    }),
    "publish smoke/swatch",
  );
  const switchYaml = `name: ${name}
input:
  prompt: { type: string }
  model: { type: string }
  session: { type: string }
steps:
  - id: work
    type: agent
    config:
      cwd: /tmp
      model: "{{ input.model }}"
      session: "{{ input.session }}"
      toolFilter: [none]
      agentTools: [smoke/swatch]
      maxSteps: 6
      system: You are a terse test agent. Use exactly the tools you are told to.
      prompt: "{{ input.prompt }}"
`;
  await json(await fetch(`${STRUT}/workflows`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ name, yaml: switchYaml }) }), "publish switch workflow");
  const turn = async (model: string, prompt: string) => {
    const launched = await json(
      await fetch(`${STRUT}/workflows/${name}/run`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ input: { prompt, model, session } }) }),
      "launch switch run",
    );
    const events = await sse(`${STRUT}/workflows/${name}/runs/${launched.runId}/stream`);
    return { events, end: events.find((e) => e.type === "step.end" && e.path === `${name}/work`) };
  };
  const turns = [
    await turn(MODEL, "Call smoke_swatch once. Then answer with the word done only — do not describe the image."),
    await turn(XAI_MODEL, "Without calling any tool: what colour fills the image smoke_swatch returned earlier? Answer with one word."),
    await turn(MODEL, "Without calling any tool: what colour did you name in your last answer? Answer with one word."),
  ];
  turns.forEach((t, i) => {
    const errs = errorsOf(t.events);
    check(`(b3) switch turn ${i}: run.end, no errors`, t.events.some((e) => e.type === "run.end") && !errs.length, errs.join(" | "));
    check(`(b3) switch turn ${i}: is turn ${i}`, t.end?.output?.session?.turn === i, JSON.stringify(t.end?.output?.session));
  });
  check("(b3) switch turn 0: called the swatch", turns[0]!.events.some((e) => e.type === "step.end" && e.stepType === "tool:smoke_swatch"));
  for (const i of [1, 2]) {
    const said = String(turns[i]!.end?.output?.result ?? "");
    check(`(b3) switch turn ${i}: names the colour`, /red/i.test(said), JSON.stringify(said).slice(0, 160));
  }
}

// ── (e) an agent run that compacts (plans/compaction.md) ──────────────────
//
// One bash result (~80k tokens) puts the run past the container's
// STRUT_COMPACT_AT (docker-compose.gateway.yml). The second command needs the
// first one's output, so the step that reads it is mid-task: the summarizer
// call replays the turn under the loop's own system + tools, then the loop
// goes on from the summary — both through the gateway. (A step that answers
// is never compacted.)

{
  const name = `${WORKFLOW}-compact`;
  const lines = 3500;
  const compactYaml = `name: ${name}
steps:
  - id: work
    type: agent
    config:
      cwd: /tmp
      model: ${MODEL}
      toolFilter: [bash]
      maxSteps: 8
      finalAnswer: The answer, as asked.
      system: You are a terse test agent. Use exactly the tools you are told to.
      prompt: >-
        Run this bash command exactly: \`for i in $(seq 1 ${lines}); do echo "line $i: the quick brown fox jumps over the lazy dog"; done\`.
        When you have its output, run the bash command \`echo strut-compact-<N>\`, where <N> is the number of
        the last line it printed. Then call final_answer with that second command's output.
`;
  await json(await fetch(`${STRUT}/workflows`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ name, yaml: compactYaml }) }), "publish compaction workflow");
  const launched = await json(
    await fetch(`${STRUT}/workflows/${name}/run`, { method: "POST", headers: strutHeaders, body: JSON.stringify({ input: {} }) }),
    "launch compaction run",
  );
  const events = await sse(`${STRUT}/workflows/${name}/runs/${launched.runId}/stream`);
  const end = events.find((e) => e.type === "step.end" && e.path === `${name}/work`);
  const result = String(end?.output?.result ?? "");
  const errs = errorsOf(events);
  check("(e) compaction run: run.end, no errors", events.some((e) => e.type === "run.end") && !errs.length, errs.join(" | "));
  check("(e) compaction run: a compaction event", events.some((e) => e.type === "step.end" && e.stepType === "compaction"));
  check("(e) compaction run: output.compactions ≥ 1", (end?.output?.compactions ?? 0) >= 1, JSON.stringify(end?.output?.usage));
  check("(e) compaction run: carried on from the summary", result.includes(`strut-compact-${lines}`), JSON.stringify(result).slice(0, 160));
}

// ── (c) xai chat turn (OpenAI-compatible route; web_fetch is aieo's shim) ──

let cChat: string | undefined;
if (XAI_MODEL !== "off") {
  const c = await chatTurn(XAI_MODEL, FETCH_PROMPT);
  cChat = c.chatId;
  const errs = errorsOf(c.events);
  check("(c) xai chat: ends with chat.end, no chat.error", c.events.some((e) => e.type === "chat.end") && !errs.length, errs.join(" | "));
}

// ── (d) the calls are in the gateway's log under their session dims ────────

// Bifrost batches log writes (every 5 s): poll until the last chat shows up.
let logs = "";
for (let i = 0; i < 10; i++) {
  logs = await fetch(`${GATEWAY}/api/logs?limit=200`, { headers: { authorization: ADMIN } }).then((r) => r.text());
  if (logs.includes(WORKFLOW) && logs.includes(cChat ?? a.chatId)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
check(`(d) gateway log: session ${WORKFLOW}`, logs.includes(WORKFLOW));
check(`(d) gateway log: chat session ${a.chatId}`, logs.includes(a.chatId));
check(`(d) gateway log: chat session ${a2.chatId}`, logs.includes(a2.chatId));
if (cChat) check(`(d) gateway log: chat session ${cChat}`, logs.includes(cChat));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\ngateway smoke passed");
