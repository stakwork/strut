// The wrapper through the REAL agent step, against a stand-in Anthropic endpoint (so the real provider
// converter runs): tools get real values, a made-up placeholder is refused where it acts, a sub-agent
// inherits the setting, and no provider request holds a real value.
import { afterEach, beforeEach, describe, it } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep } from "../core.js";
import { MemorySessionStore, sessionsCapability } from "../session-store.js";
import agent from "../steps/core/agent.js";
import { FIX, REAL_VALUES, makeCtx, uid } from "./testing/harness.js";
import { normalizePrivacy } from "./settings.js";

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const msgStart = () => sse({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
const toolUse = (id: string, name: string, input: unknown) =>
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
  sse({ type: "message_stop" });

async function serve(replies: Array<[string, string, unknown]>) {
  const bodies: any[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const r = replies[n++];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      res.write(toolUse(r![0], r![1], r![2]));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;
  return { bodies, calls: () => n, close: () => server.close() };
}

const calls: Record<string, unknown[]> = {};
const rec = (name: string) => (input: unknown) => { (calls[name] ??= []).push(input); return { ok: true }; };
const mkStep = (type: string, extra: Record<string, unknown> = {}) =>
  defineStep({ type, description: type, input: z.object({ to: z.string().optional(), text: z.string().optional() }).passthrough(), output: z.any(), async run(c: any) { return rec(type)(c); }, ...extra } as any);
const registry: Record<string, any> = {
  "sphinx/send": mkStep("sphinx/send"),
  "memory/remember": mkStep("memory/remember"),
  "automation/create": mkStep("automation/create"),
  "dev/read": mkStep("dev/read", { effect: "read" }),
  "dev/keep": mkStep("dev/keep", { privacy: "keep" }),
  "dev/acts": mkStep("dev/acts", { sideEffects: true }),
};

describe("privacy through the agent step", () => {
  let cwd = "";
  const saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AI_SDK_LOG_WARNINGS", "STRUT_LLM_PROVIDER"];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "strut-privacy-agent-"));
    for (const k of ENV) saved[k] = process.env[k];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    for (const k of Object.keys(calls)) delete calls[k];
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); });

  const run = (cfg: Record<string, unknown>, ctxOver: Record<string, unknown> = {}) => {
    const ctx = makeCtx({ privacy: "hosted", registry, services: { sessions: sessionsCapability(new MemorySessionStore()) }, ...ctxOver });
    ctx.settings = { ...ctx.settings, privacy: normalizePrivacy(ctx.settings!["privacy"]) as any };
    return (agent.run((agent.input as any).parse({
      cwd, system: "sys", model: "claude-sonnet-4-5", finalAnswer: "Report.", toolFilter: ["none"], reasoning: "provider-default",
      prompt: `Message ${FIX.person} (${FIX.email}) about the invoice; she works at ${FIX.org}.`, ...cfg,
    }), ctx as any) as Promise<any>).then((out) => ({ out, ctx }));
  };
  const wire = (s: { bodies: any[] }) => JSON.stringify(s.bodies);

  it("each tool receives the real name; the provider never sees a real value; the answer is restored", async () => {
    const s = await serve([
      ["t1", "sphinx_send", { to: "[PERSON_1]", text: "Hello [PERSON_1], see [EMAIL_1]" }],
      ["t2", "memory_remember", { to: "[PERSON_1]", text: "[PERSON_1] works at [ORG_1]" }],
      ["t3", "automation_create", { text: "remind [PERSON_1] on Monday" }],
      ["t4", "final_answer", { answer: "Told [PERSON_1] ([EMAIL_1])." }],
    ]);
    try {
      const events: any[] = [];
      const { out } = await run({ agentTools: ["sphinx/send", "memory/remember", "automation/create"], session: uid("tool") }, { emit: async (e: any) => void events.push(e) });
      assert.equal((calls["sphinx/send"]![0] as any).to, FIX.person);
      assert.equal((calls["sphinx/send"]![0] as any).text, `Hello ${FIX.person}, see ${FIX.email}`);
      assert.equal((calls["memory/remember"]![0] as any).text, `${FIX.person} works at ${FIX.org}`);
      assert.equal((calls["automation/create"]![0] as any).text, `remind ${FIX.person} on Monday`);
      for (const v of REAL_VALUES) assert.ok(!wire(s).includes(v), `leaked ${v}`);
      assert.ok(wire(s).includes("[PERSON_1]"));
      assert.ok(!wire(s).includes("strutPrivacy"));
      assert.equal(out.result, `Told ${FIX.person} (${FIX.email}).`);
      const ev = events.find((e) => e.type === "privacy.masked");
      assert.ok(ev && ev.counts.PERSON >= 1, "counts-only event");
      assert.ok(!JSON.stringify(events.filter((e) => e.type === "privacy.masked")).includes(FIX.person));
      // the session's earlier requests are byte-stable prefixes of the later ones
      const msgs = s.bodies.map((b) => JSON.stringify(b.messages));
      for (let i = 0; i + 1 < msgs.length; i++) assert.ok(msgs[i + 1]!.startsWith(msgs[i]!.slice(0, -1)), `request ${i + 1} extends ${i}`);
    } finally { s.close(); }
  });

  it("a made-up placeholder is refused by a side-effecting tool and only warned for a read-only one; privacy: keep keeps pseudonyms", async () => {
    const s = await serve([
      ["u1", "sphinx_send", { to: "[PERSON_7]", text: "hi" }],
      ["u2", "dev_acts", { to: "[PERSON_8]" }],
      ["u3", "dev_read", { to: "[PERSON_9]" }],
      ["u4", "dev_keep", { to: "[PERSON_1]" }],
      ["u5", "final_answer", { answer: "ok" }],
    ]);
    const warns: string[] = []; const w = console.warn; console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      await run({ agentTools: ["sphinx/send", "dev/acts", "dev/read", "dev/keep"], session: uid("guard") });
      assert.equal(calls["sphinx/send"], undefined, "refused: never ran");
      assert.equal(calls["dev/acts"], undefined, "sideEffects: true is refused too");
      assert.deepEqual((calls["dev/read"]![0] as any).to, "[PERSON_9]");
      assert.ok(warns.some((x) => x.includes("[PERSON_9]")));
      assert.equal((calls["dev/keep"]![0] as any).to, "[PERSON_1]", "kept the pseudonym");
      assert.match(wire(s), /unknown placeholder \[PERSON_7\]; use only names you were given/);
    } finally { console.warn = w; s.close(); }
  });

  it("a sub-agent inherits the setting: its own provider requests hold no real value", async () => {
    const s = await serve([
      ["a1", "agent", { prompt: "Greet [PERSON_1] politely.", toolFilter: ["none"], finalAnswer: "A greeting." }],
      ["a2", "final_answer", { answer: "Dear [PERSON_1], hello." }], // the sub-agent's answer
      ["a3", "final_answer", { answer: "done" }],
    ]);
    try {
      const { out } = await run({ agentTools: ["agent"], session: uid("sub") });
      assert.ok(s.calls() >= 2);
      assert.ok(String(out.result).includes(FIX.person), "the sub-agent's answer came back restored");
      for (const v of REAL_VALUES) assert.ok(!wire(s).includes(v), `leaked ${v}`);
      // the sub-agent's request (the second) carries a pseudonym, not the name the parent's tool call restored
      assert.ok(JSON.stringify(s.bodies[1]).includes("Greet [PERSON_1]"));
    } finally { s.close(); }
  });

  it("privacy off: nothing is masked", async () => {
    const s = await serve([["o1", "final_answer", { answer: "ok" }]]);
    try {
      await run({ session: uid("off") }, { privacy: "off" });
      assert.ok(wire(s).includes(FIX.person));
    } finally { s.close(); }
  });
});
