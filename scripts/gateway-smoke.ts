/**
 * End-to-end: strut → Mothership → stakgraph-gateway (Bifrost) → provider,
 * against `docker compose -f docker-compose.yml -f docker-compose.gateway.yml
 * up`. strut there holds NO provider keys, so everything passing here went
 * through the gateway. Opt-in: `STRUT_TEST_GATEWAY=1 npm run test:gateway`.
 *
 * Checks: (a) an Anthropic chat turn that calls the native web_fetch,
 * (b) a workflow run with an agent step (web_fetch + bash) and an llm step,
 * (c) an xai chat turn (OpenAI-compatible route), (d) the gateway's log has
 * the calls under their session dims (the workflow name, the chat id).
 *
 * Negative control: point the compose's gateway at a transports/v1.6.2 build
 * and set STRUT_TEST_GATEWAY_EXPECT_BROKEN=1 — (a) must then die with
 * `Type validation failed: Value: {"type":"content_block_start"…` (a headless
 * frame from Bifrost's re-rendered Anthropic stream); (c) must still pass.
 * (b) is only reported: the agent step skips the bad chunk and succeeds.
 *
 * Env: STRUT_URL (http://localhost:3000), GATEWAY_URL (http://localhost:8181,
 * as this script sees it), GATEWAY_INNER_URL (http://gateway:8181, as strut
 * sees it — what the delegation records), STRUT_API_KEY (strut-dev-key),
 * BIFROST_ADMIN_USER/PASS (admin / bifrost-dev-password),
 * STRUT_TEST_GATEWAY_MODEL (claude-sonnet-5), STRUT_TEST_GATEWAY_XAI_MODEL
 * (xai/grok-4.7; "off" skips c).
 */
import { randomBytes } from "node:crypto";
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
const EXPECT_BROKEN = process.env["STRUT_TEST_GATEWAY_EXPECT_BROKEN"] === "1";

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

const errorsOf = (events: Ev[]) =>
  events
    .filter((e) => e.type === "chat.error" || e.type === "run.error" || e.type === "step.error" || e.status === "error")
    .map((e) => JSON.stringify(e.error ?? e));

/** Assert a turn/run died of THE bug; print the whole error so it is recognisable. */
function expectBug(name: string, events: Ev[]) {
  const errs = errorsOf(events);
  for (const e of errs) console.log(`    ${e}`);
  check(`${name} fails with the headless content_block_start frame`, errs.some((e) => e.includes("Type validation failed") && e.includes("content_block_start")), errs.length ? "" : "no error at all");
}

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
console.log(`actor ${ACTOR}, workflow ${WORKFLOW}, gateway ${GATEWAY_INNER} (from strut)${EXPECT_BROKEN ? " — EXPECTING THE v1.6.2 BUG" : ""}`);

const FETCH_PROMPT =
  "Use your web_fetch tool on https://example.com/ (do not guess, do not use any other tool) and reply with the page's <title> text only.";

// ── (a) anthropic chat turn with native web_fetch ──────────────────────────

const a = await chatTurn(MODEL, FETCH_PROMPT);
if (EXPECT_BROKEN) expectBug("(a) anthropic chat", a.events);
else {
  const errs = errorsOf(a.events);
  check("(a) anthropic chat: web_fetch called", a.events.some((e) => e.type === "tool-input" && e.toolName === "web_fetch"));
  check("(a) anthropic chat: ends with chat.end, no chat.error", a.events.some((e) => e.type === "chat.end") && !errs.length, errs.join(" | "));
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
if (EXPECT_BROKEN) {
  // Not asserted: the agent step drains its stream with consumeStream, which
  // skips an unparseable chunk instead of failing, so on v1.6.2 the run still
  // succeeds (without that frame's block). Only the chat turn dies of it.
  const errs = errorsOf(b);
  console.log(`  (b) under the bug: run ${b.some((e) => e.type === "run.end") ? "ended ok" : "failed"}${errs.length ? ` — ${errs[0]}` : ""}`);
} else {
  const end = b.find((e) => e.type === "step.end" && e.path === `${WORKFLOW}/research`);
  const result = String(end?.output?.result ?? "");
  const errs = errorsOf(b);
  check("(b) run: run.end, no errors", b.some((e) => e.type === "run.end") && !errs.length, errs.join(" | "));
  check("(b) run: agent's tool:bash step event", b.some((e) => e.type === "step.end" && e.stepType === "tool:bash"));
  // Anthropic's web_fetch is provider-executed (no `execute`), so it gets no
  // tool:* run event — the fetched title in the result is the proof.
  check("(b) run: agent fetched the page", /example domain/i.test(result), JSON.stringify(result).slice(0, 120));
  const llm = b.find((e) => e.type === "step.end" && e.path === `${WORKFLOW}/summarize`);
  check("(b) run: llm step answered", /example domain/i.test(String(llm?.output?.text ?? "")));
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
if (cChat) check(`(d) gateway log: chat session ${cChat}`, logs.includes(cChat));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\ngateway smoke passed");
