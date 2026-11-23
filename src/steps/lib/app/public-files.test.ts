/**
 * `app/public-files` (plans/support-ai.md §2.2): the apps in the public view,
 * read as their sources at the version people open — the one
 * `/public/apps` serves — and nothing private: no app outside the view, no
 * other version, nothing outside the version's tree (`dist/`, a path that
 * climbs out).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut, type Strut } from "../../../createStrut.js";
import { WorkspaceManager } from "../../../workspace.js";
import { MemoryRunStore } from "../../../store.js";
import type { StepContext } from "../../../core.js";
import { kitForTests } from "../../../test-util/app-kit.js";

const KEY = "public-files-key";
const auth = { authorization: `Bearer ${KEY}` };
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

describe("app/public-files", () => {
  let root: string;
  let strut: Strut;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_SECRET_KEY"] = "public-files-secret";
    root = await mkdtemp(join(tmpdir(), "strut-public-files-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store: new MemoryRunStore(),
      kit: await kitForTests(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      autoResume: false,
      stt: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      staff: false,
      jamie: false,
      knowledge: false,
      earnings: false,
      concepts: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
    });
    await publish("workers", "Workers", "one");
    await publish("secret", "Secret", "private");
    // The public view adds the worker app, held at v1.
    const res = await strut.app.request("/public-view", {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ concepts: [], workflows: [], steps: [], types: [], apps: [{ name: "workers" }], runnable: [] }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    // A later publish is a draft: people still open v1.
    await publish("workers", "Workers", "two");
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });

  /** An app whose page says `word`, with a long text file and a binary one. */
  const publish = async (name: string, title: string, word: string) => {
    const dir = join(root, "apps", name);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), `title: ${title}\ndescription: The ${word} app.\n`);
    await writeFile(join(dir, "src", "App.tsx"), `export default function App() { return <p>${word}</p>; }\n`);
    await writeFile(join(dir, "src", "long.md"), "a".repeat(5000) + "z".repeat(5000));
    await writeFile(join(dir, "src", "blob.bin"), new Uint8Array([1, 0, 2]));
    const r = await strut.apps.publish(dir, name, { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  };
  const ctx = (): StepContext => ({ runId: "r1", path: "support/reply", scope: {}, input: undefined, emit: async () => {}, services: strut.services, registry: strut.getRegistry() });
  const read = (config: Record<string, unknown>) => strut.getRegistry()["app/public-files"]!.run(config as never, ctx()) as Promise<Record<string, any>>;

  it("with no app: the public view's apps at the version people open, never a private one", async () => {
    assert.deepEqual(await read({}), { apps: [{ app: "workers", version: "v1", title: "Workers", description: "The one app." }] });
  });

  it("with an app: its sources at that version, each with the sha256 of its bytes, and no dist/", async () => {
    const out = await read({ app: "workers" });
    assert.equal(out["version"], "v1");
    const files = out["files"] as Array<{ path: string; size: number; sha: string }>;
    assert.deepEqual(files.map((f) => f.path), ["app.yaml", "src/App.tsx", "src/blob.bin", "src/long.md"]);
    const app = files.find((f) => f.path === "src/App.tsx")!;
    const text = "export default function App() { return <p>one</p>; }\n";
    assert.deepEqual(app, { path: "src/App.tsx", size: Buffer.byteLength(text), sha: sha(text) });
  });

  it("with a path: the file's text at the version people open, the sha the list gives", async () => {
    const out = await read({ app: "workers", path: "src/App.tsx" });
    assert.equal(out["text"], "export default function App() { return <p>one</p>; }\n", "v1, not the draft v2");
    assert.equal(out["version"], "v1");
    assert.equal(out["sha"], sha(out["text"]));
    assert.equal(out["truncated"], undefined);
    assert.equal((await read({ app: "workers", path: "./src/App.tsx" }))["text"], out["text"], "a leading ./ is the same path");
  });

  it("a long file comes back head and tail; a binary one says so", async () => {
    const long = await read({ app: "workers", path: "src/long.md", maxChars: 100 });
    assert.equal(long["truncated"], true);
    assert.match(long["text"], /^a{50}\n\[\.\.\. 9900 chars truncated \.\.\.\]\nz{50}$/);
    assert.equal(long["size"], 10_000);
    const bin = await read({ app: "workers", path: "src/blob.bin" });
    assert.equal(bin["binary"], true);
    assert.equal(bin["text"], undefined);
  });

  it("refuses an app outside the public view, and any path outside the version's tree", async () => {
    await assert.rejects(read({ app: "secret" }), /not_public: app "secret" is not in this server's public view/);
    await assert.rejects(read({ app: "secret", path: "src/App.tsx" }), /not_public/);
    await assert.rejects(read({ app: "nope" }), /not_public/);
    for (const path of ["dist/index.html", "../secret/v1/src/App.tsx", "src/../app.yaml", "/etc/passwd", "src"]) {
      await assert.rejects(read({ app: "workers", path }), /No file .* in workers@v1's sources/, path);
    }
  });

  it("takes a path only with an app", () => {
    const parsed = strut.getRegistry()["app/public-files"]!.input.safeParse({ path: "src/App.tsx" });
    assert.equal(parsed.success, false);
  });

  it("follows the version people open: made live, v2 is what it reads", async () => {
    await strut.apps.promote("workers", "v2");
    assert.equal((await read({ app: "workers", path: "src/App.tsx" }))["text"], "export default function App() { return <p>two</p>; }\n");
    assert.equal((await read({}))["apps"][0].version, "v2");
  });
});
