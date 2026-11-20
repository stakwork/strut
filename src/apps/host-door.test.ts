import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createStrut, HOST_CALL_BODY_MAX_BYTES, type Strut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep } from "../core.js";
import { FileWorkspaceStore } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { appIdentity } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";
import { parseManifest } from "./manifest.js";

/**
 * A host calls an app's tools (plans/people-and-hosts.md §3): a host key on
 * `POST /mcp` gets `step_run { app, type, config }` alone, the app named by
 * its name at its live version, checked against the app's `hosts:`, as the
 * account `x-strut-account` names — its person, or with `unlinked: true` the
 * key's own actor. The step reads `ctx.host` and `ctx.app` off the shared
 * bag alone. The answer is synchronous: 200 only when the step finished.
 * Nothing here is about Sphinx or Support: the apps and steps are tests'.
 */

const KEY = "host-door-key";
const SPHINX = "host-door-sphinx";
const EMAIL = "host-door-email";
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const PUB = `02${"ab".repeat(32)}`;
const OTHER = `03${"cd".repeat(32)}`;
const UNLINKED_ACTOR = `secp:${"ab".repeat(32)}`;

/** What a host's call sees: who it runs as, the host and the app, and what is on its bag. */
const receive = defineStep({
  type: "test/receive",
  input: z.object({ text: z.string().optional(), file: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    const bag = (ctx.services ?? {}) as Record<string, unknown>;
    const tasks = (bag["tasks"] ?? {}) as Record<string, unknown>;
    return {
      text: cfg.text ?? null,
      fileChars: cfg.file?.length ?? 0,
      host: ctx.host ?? null,
      app: ctx.app ?? null,
      actor: ctx.actor ?? null,
      bag: Object.keys(bag).sort(),
      workerCalls: ["next", "submit", "skip", "file", "me"].filter((k) => typeof tasks[k] === "function"),
    };
  },
});
const other = defineStep({ type: "test/other", input: z.object({}), output: z.any(), run: async () => ({ ok: true }) });
const broken = defineStep({
  type: "test/broken",
  input: z.object({}),
  output: z.any(),
  run: async () => {
    throw new Error("the store is down");
  },
});

/** A tool's error text: its `{ error }`, or the text as it came. */
const errorOf = (content: string | undefined): string => {
  try {
    return (JSON.parse(content ?? "") as { error?: string }).error ?? content ?? "error";
  } catch {
    return content ?? "error";
  }
};

/** A JSON-RPC body. */
const rpcBody = (method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

describe("a host calls an app's tools (plans/people-and-hosts.md §3)", () => {
  const saved = { api: process.env["STRUT_API_KEY"], hosts: process.env["STRUT_HOST_KEYS"] };
  let root: string;
  let strut: Strut;
  const store = new MemoryRunStore();

  /** A host's call of `step_run`: the status, and the tool's result or error. */
  const call = async (args: { app: string; type: string; config?: unknown }, o: { key?: string; account?: string | null; name?: string; body?: string } = {}) => {
    const headers: Record<string, string> = { ...MCP_HEADERS, authorization: `Bearer ${o.key ?? SPHINX}` };
    if (o.account !== null) headers["x-strut-account"] = o.account ?? `sphinx:${PUB}`;
    if (o.name !== undefined) headers["x-strut-account-name"] = o.name;
    const res = await strut.app.request("/mcp", { method: "POST", headers, body: o.body ?? rpcBody("tools/call", { name: "step_run", arguments: args }) });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const r = body?.result;
    const content = r?.content?.[0]?.text as string | undefined;
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text,
      ...(r?.isError ? { error: errorOf(content) } : r ? { result: r.structuredContent ?? (content ? JSON.parse(content) : undefined) } : {}),
    } as { status: number; contentType: string; text: string; result?: any; error?: string };
  };

  const publish = async (name: string, yaml: string, surface: "person" | "ai" = "person") => {
    const dir = join(root, "src", name);
    const files: Record<string, string> = {
      "app.yaml": yaml,
      "src/App.tsx": 'export default function App() { return <p className="p-2">hi</p>; }\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, dirname(rel)), { recursive: true });
      await writeFile(join(dir, rel), text, "utf8");
    }
    return strut.apps.publish(dir, name, { surface });
  };

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_HOST_KEYS"] = `sphinx:${SPHINX},email:${EMAIL}`;
    const kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-host-door-"));
    strut = await createStrut({
      workspace: new FileWorkspaceStore(join(root, "ws")),
      store,
      registry: await createRegistry([receive, other, broken]),
      kit,
      scheduler: false,
      serveUi: false,
      enableChat: false,
      enableMcp: true,
      job: false,
      orchestrator: false,
      builder: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      views: false,
    });
    for (const [name, yaml] of [
      // An inbox any Sphinx account may write to; its page may call nothing.
      ["inbox", "title: Inbox\nhosts:\n  sphinx:\n    steps: [test/receive, test/broken]\n    unlinked: true\n"],
      // Linked people only.
      ["members", "title: Members\nhosts:\n  sphinx:\n    steps: [test/re*]\ngrants:\n  steps: [test/receive]\n"],
      // Another host's.
      ["mail", "title: Mail\nhosts:\n  email:\n    steps: [test/receive]\n    unlinked: true\n"],
      // No host at all.
      ["page-only", "title: Page only\ngrants:\n  steps: [test/receive]\n"],
    ] as const) {
      const r = await publish(name, yaml);
      assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    }
    await strut.people.link({ kind: "sphinx", key: OTHER }, "alice", { host: "sphinx" });
    await strut.people.link({ kind: "email", key: "ada@example.com" }, "ada", { host: "email" });
  });

  after(async () => {
    await strut?.close();
    await rm(root, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_HOST_KEYS", saved.hosts]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("calls a step the app's hosts: lists and gets its result, synchronously, with ctx.host and ctx.app set and nothing kept", async () => {
    const r = await call({ app: "inbox", type: "test/receive", config: { text: "hi" } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.contentType, /application\/json/, "one JSON answer, never a stream");
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.result.text, "hi");
    assert.deepEqual(r.result.host, { name: "sphinx", account: `sphinx:${PUB}`, unlinked: true });
    assert.deepEqual(r.result.app, { name: "inbox", version: "v1" }, "the live version, never first-party or an admin's");
    assert.equal(r.result.actor, UNLINKED_ACTOR, "nobody linked it: the key's own actor");
    // The app's live version: a new one is what the next call runs.
    const v2 = await publish("inbox", "title: Inbox two\nhosts:\n  sphinx:\n    steps: [test/receive, test/broken]\n    unlinked: true\n");
    assert.ok(v2.ok && v2.version === "v2");
    assert.deepEqual((await call({ app: "inbox", type: "test/receive" })).result.app, { name: "inbox", version: "v2" });
    // The door keeps nothing.
    assert.deepEqual(await store.listRuns("step:test/receive"), []);
    // tools/list: step_run alone.
    const list = await call({ app: "", type: "" }, { body: rpcBody("tools/list", {}) });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(JSON.parse(list.text).result.tools.map((t: { name: string }) => t.name), ["step_run"]);
  });

  it("the bag is the shared one alone: no admin door, no worker's calls, nothing that pays or sends", async () => {
    const r = await call({ app: "inbox", type: "test/receive" });
    assert.equal(r.status, 200, r.text);
    for (const k of ["payer", "earningsAdmin", "staffAdmin", "sphinx", "workerAddress", "workerApps"]) assert.ok(!r.result.bag.includes(k), `${k} on a host's bag: ${r.result.bag.join(", ")}`);
    assert.deepEqual(r.result.workerCalls, [], "the task store's ensure alone, as on the shared bag");
    // A page's call on the same app's step has no ctx.host.
    const page = await strut.app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY}` },
      body: rpcBody("tools/call", { name: "step_run", arguments: { type: "test/receive", config: {}, app: appIdentity("page-only", "v1") } }),
    });
    const text = await page.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const result = JSON.parse(line ? line.slice(6) : text).result;
    assert.equal(result.isError, undefined, text);
    assert.equal((result.structuredContent ?? JSON.parse(result.content[0].text)).host, null);
  });

  it("a linked account runs as its person", async () => {
    const r = await call({ app: "members", type: "test/receive" }, { account: `sphinx:${OTHER}` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.result.actor, "alice");
    assert.deepEqual(r.result.host, { name: "sphinx", account: `sphinx:${OTHER}`, unlinked: false });
  });

  it("refuses a step hosts: does not list, another app, and another host key's — 403, with why", async () => {
    const unlisted = await call({ app: "inbox", type: "test/other" });
    assert.equal(unlisted.status, 403, unlisted.text);
    assert.match(unlisted.error ?? "", /step_run refused: step "test\/other" is not one this app lets sphinx call/);
    const noHosts = await call({ app: "page-only", type: "test/receive" });
    assert.equal(noHosts.status, 403);
    assert.match(noHosts.error ?? "", /hosts: does not name "sphinx"/, "a page's grants are not a host's");
    const othersApp = await call({ app: "mail", type: "test/receive" });
    assert.equal(othersApp.status, 403);
    assert.match(othersApp.error ?? "", /does not name "sphinx"/);
    const otherKey = await call({ app: "inbox", type: "test/receive" }, { key: EMAIL, account: "email:ada@example.com" });
    assert.equal(otherKey.status, 403, "another host key: not the one inbox names");
    assert.match(otherKey.error ?? "", /does not name "email"/);
    const itsOwn = await call({ app: "mail", type: "test/receive" }, { key: EMAIL, account: "email:ada@example.com" });
    assert.equal(itsOwn.status, 200, itsOwn.text);
    assert.deepEqual([itsOwn.result.actor, itsOwn.result.host.name], ["ada", "email"]);
    const nobody = await call({ app: "mail", type: "test/receive" }, { key: EMAIL, account: "email:bob@example.com" });
    assert.equal(nobody.status, 403, "an email account nobody linked is nobody, whatever unlinked: says");
    assert.match(nobody.text, /not_linked/);
    const missing = await call({ app: "nope", type: "test/receive" });
    assert.equal(missing.status, 403);
    assert.match(missing.error ?? "", /no app "nope"/);
    // Only the routes a host key has: the builder's door stays closed.
    const builder = await strut.app.request("/mcp/builder", { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${SPHINX}`, "x-strut-account": `sphinx:${PUB}` }, body: rpcBody("tools/list", {}) });
    assert.equal(builder.status, 403);
  });

  it("an account nobody linked is refused unless the app says unlinked: true; no account at all is a 400", async () => {
    const r = await call({ app: "members", type: "test/receive" });
    assert.equal(r.status, 403, r.text);
    assert.match(r.error ?? "", /not_linked: sphinx:02ab.* does not say unlinked: true/);
    const none = await call({ app: "inbox", type: "test/receive" }, { account: null });
    assert.equal(none.status, 400);
    assert.match(none.text, /x-strut-account is required/);
    const wrongKind = await call({ app: "inbox", type: "test/receive" }, { account: `email:${PUB}` });
    assert.equal(wrongKind.status, 400, "an account of the kind this host vouches for");
  });

  it("a step that fails answers 500, so the host sends it again", async () => {
    const r = await call({ app: "inbox", type: "test/broken" });
    assert.equal(r.status, 500, r.text);
    assert.match(r.error ?? "", /the store is down/);
    const badArgs = await call({ app: "inbox", type: 7 as unknown as string });
    assert.equal(badArgs.status, 400, badArgs.text);
  });

  it("a config the step's input does not take answers 400, naming the field, and the step never runs", async () => {
    const r = await call({ app: "inbox", type: "test/receive", config: { text: 42 } });
    assert.equal(r.status, 400, r.text);
    assert.match(r.error ?? "", /test\/receive cannot take this config: text:/);
  });

  it("x-strut-account-name keeps the name the speaker goes by: as the key's own actor's while unlinked, on the account once linked", async () => {
    const r = await call({ app: "inbox", type: "test/receive" }, { name: encodeURIComponent("Zoë 🌱\nworker") });
    assert.equal(r.status, 200, r.text);
    assert.equal(await strut.people.nameOf(UNLINKED_ACTOR), "Zoë 🌱 worker");
    // A host's name for that actor is never replaced by one a person wrote.
    await strut.people.setName(UNLINKED_ACTOR, "Zoe (staff)", "host");
    await call({ app: "inbox", type: "test/receive" }, { name: "Z" });
    assert.equal(await strut.people.nameOf(UNLINKED_ACTOR), "Zoe (staff)");
    // Linked: on the account, read beneath the person's own name.
    await call({ app: "members", type: "test/receive" }, { account: `sphinx:${OTHER}`, name: encodeURIComponent("Alice A.") });
    assert.equal((await strut.people.linkOf({ kind: "sphinx", key: OTHER }))?.name, "Alice A.");
    assert.equal(await strut.people.nameOf("alice"), "Alice A.");
    await strut.people.setName("alice", "Alice Anders", "host");
    await call({ app: "members", type: "test/receive" }, { account: `sphinx:${OTHER}`, name: "Al" });
    assert.equal(await strut.people.nameOf("alice"), "Alice Anders", "the person's own name comes first");
    assert.equal((await strut.people.linkOf({ kind: "sphinx", key: OTHER }))?.name, "Al");
    // Malformed, or with no account to name.
    assert.equal((await call({ app: "inbox", type: "test/receive" }, { name: "%E0%A4%A" })).status, 400);
    assert.equal((await call({ app: "inbox", type: "test/receive" }, { account: null, name: "x" })).status, 400);
  });

  it("takes a 25 MiB file as base64 and refuses a body over HOST_CALL_BODY_MAX_BYTES (413)", async () => {
    const file = Buffer.alloc(25 * 1024 * 1024, 7).toString("base64");
    const big = await call({ app: "inbox", type: "test/receive", config: { file } });
    assert.equal(big.status, 200, big.text.slice(0, 300));
    assert.equal(big.result.fileChars, file.length);
    const over = rpcBody("tools/call", { name: "step_run", arguments: { app: "inbox", type: "test/receive", config: { file: "x".repeat(HOST_CALL_BODY_MAX_BYTES) } } });
    const refused = await call({ app: "", type: "" }, { body: over });
    assert.equal(refused.status, 413, refused.text.slice(0, 300));
  });

  it("only a person's publish (or strut's seed) may write hosts:, never a model's", async () => {
    const ai = await publish("by-model", "title: By a model\nhosts:\n  sphinx:\n    steps: [test/receive]\n", "ai");
    assert.equal(ai.ok, false);
    assert.match(ai.ok ? "" : ai.errors.join("\n"), /hosts: only a person lets a host call an app's tools/);
    const without = await publish("by-model", "title: By a model\n", "ai");
    assert.ok(without.ok, without.ok ? "" : without.errors.join("\n"));
    // The shape is checked like the rest of app.yaml.
    const bad = parseManifest("title: x\nhosts:\n  Sphinx:\n    steps: []\n    extra: 1\n");
    assert.equal(bad.ok, false);
    const errors = bad.ok ? "" : bad.errors.join("\n");
    assert.match(errors, /a host is named as STRUT_HOST_KEYS names it/);
    assert.match(errors, /steps names at least one tool/);
  });
});
