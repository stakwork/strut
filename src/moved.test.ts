/**
 * A booted strut's folder copied to another host (src/moved.ts): to a path
 * of its own, beside a bridge on another port with another token, and back
 * again. After `moved.json`, every callback reaches the new bridge, the
 * bridge secrets are the new host's, and every upload path a conversation
 * replays opens on the new host.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { stepRunKey, type FileRunStore } from "./store.js";
import { FileSecretStore } from "./secret-store.js";
import { attachmentParts, saveAttachments } from "./ai/attachments.js";
import { jobRoot, setJobCallback, touchJob } from "./jobs.js";
import { applyMove, MOVED_FILE, type Moved } from "./moved.js";

const WF = "echo";
const steps = [{ id: "out", type: "pack", config: { ok: true } }];

interface Bridge {
  url: string;
  token: string;
  posts: string[];
  server: http.Server;
}

async function bridge(): Promise<Bridge> {
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      posts.push(req.url!);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: randomUUID(), posts, server };
}

const port = (b: Bridge) => new URL(b.url).port;
const runEnd = (b: Bridge) => `${b.url}/bridge/run-end?token=${b.token}`;

function boot(dir: string): Promise<Strut> {
  return createStrut({ workspace: new WorkspaceManager(dir), serveUi: false, scheduler: false, systemWorkflows: false, autoResume: false });
}

async function call(strut: Strut, method: string, path: string, body?: unknown) {
  const res = await strut.app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** The `[attachment] … — saved at <path>` path in a conversation's first line. */
async function savedAt(file: string): Promise<string> {
  const line = JSON.parse((await readFile(file, "utf-8")).split("\n")[0]!) as { content: Array<{ text?: string }> };
  return /saved at (.+)$/m.exec(line.content[0]!.text!)![1]!;
}

/** Every file under `dir` with its bytes. */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await readdir(dir, { recursive: true })) {
    const path = join(dir, name);
    if ((await stat(path)).isFile()) out.set(relative(dir, path), (await readFile(path)).toString("base64"));
  }
  return out;
}

describe("a data folder moved to another host", () => {
  const root = join(tmpdir(), `strut-moved-${randomUUID()}`);
  // The Mac's folder, the box's, and the Mac's again under another profile.
  const mac = join(root, "mac", "Library", "Application Support", "Peel", "Strut", "workspace");
  const box = join(root, "box", "data", "strut", "workspace");
  const back = join(root, "mac2", "Library", "Application Support", "Peel", "Strut", "workspace");
  let macBridge: Bridge, boxBridge: Bridge, backBridge: Bridge;
  let automation: string;
  let savedKey: string | undefined;

  before(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
    [macBridge, boxBridge, backBridge] = await Promise.all([bridge(), bridge(), bridge()]);

    // A strut on the Mac, pointed at the Mac's bridge everywhere it keeps one.
    await mkdir(mac, { recursive: true });
    const strut = await boot(mac);
    await strut.workspace.publishWorkflow(WF, "v1", { steps });
    const made = await call(strut, "POST", `/workflows/${WF}/automations`, {
      name: "Reminder", trigger: { every: "day", at: ["09:00"], tz: "UTC" }, callback: { url: runEnd(macBridge) },
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    automation = made.json.automation.id;
    const store = strut.store as FileRunStore;
    await store.setRunCallback(WF, "1000", runEnd(macBridge));
    await store.setRunJobCallback(WF, "1000", runEnd(macBridge));
    await store.setRunMcp(WF, "1000", [
      { name: "bridge", url: `${macBridge.url}/mcp`, token: macBridge.token },
      { name: "hive", url: "https://hive.test/mcp", token: "hive-token" },
    ]);
    await store.setRunCallback(stepRunKey("pack"), "2000", runEnd(macBridge));
    await setJobCallback(jobRoot(mac, "j1"), runEnd(macBridge));
    // The job's own file, and a checkout: a worktree of a cache in repos/,
    // which a plain copy brings along broken.
    const job = jobRoot(mac, "j1");
    const cache = join(mac, "repos", "acme", "repo.git");
    await mkdir(join(job, "repo"), { recursive: true });
    await writeFile(join(job, "plan.md"), "the job's own file");
    await writeFile(join(job, "repo", ".git"), `gitdir: ${join(cache, "worktrees", "repo")}\n`);
    await touchJob(job, "j1", { dir: join(job, "repo"), cache, ref: "main" });
    assert.equal((await call(strut, "PUT", "/secrets/PEEL_BRIDGE_PORT", { value: port(macBridge) })).status, 200);
    assert.equal((await call(strut, "PUT", "/secrets/PEEL_BRIDGE_TOKEN", { value: macBridge.token })).status, 200);
    assert.equal((await call(strut, "PUT", "/secrets/OTHER", { value: "kept" })).status, 200);

    // A chat upload and a run attachment, as the conversations replay them.
    const note = { name: "note.txt", mediaType: "text/plain", bytes: Buffer.from("hello from the mac") };
    const [path] = await saveAttachments(mac, "c1", [note]);
    await mkdir(join(mac, "chats", "c1"), { recursive: true });
    const chatLine = { role: "user", content: await attachmentParts(note, path!) };
    await writeFile(join(mac, "chats", "c1", "messages.jsonl"), `${JSON.stringify(chatLine)}\n${JSON.stringify({ role: "assistant", content: "ok" })}\n`);
    const shot = join(mac, "artifacts", "1000", "attachments", "shot.txt");
    await mkdir(join(shot, ".."), { recursive: true });
    await writeFile(shot, "a run attachment");
    await mkdir(join(mac, "sessions", "dm"), { recursive: true });
    const sessionLine = { role: "user", content: await attachmentParts({ ...note, name: "shot.txt", bytes: Buffer.from("a run attachment") }, shot) };
    await writeFile(join(mac, "sessions", "dm", "messages.jsonl"), `${JSON.stringify(sessionLine)}\n`);

    // Parts tied to the Mac.
    for (const rel of ["steps/_graph/x/index.ts", "acp/sessions/a.json", "audio/dictation.json", "privacy/vault/v.json"]) {
      await mkdir(join(mac, rel, ".."), { recursive: true });
      await writeFile(join(mac, rel), "{}");
    }
    await writeFile(join(mac, "secrets.json.corrupt-2026"), "x");
    await strut.close();
  });

  after(async () => {
    for (const b of [macBridge, boxBridge, backBridge]) b.server.close();
    await rm(root, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
  });

  /** Copy the stopped folder and leave `moved.json`, as a mover does. */
  async function move(from: string, to: string, was: Bridge, now: Bridge): Promise<Moved> {
    await cp(from, to, { recursive: true });
    const moved: Moved = {
      from,
      bridge: { from: { url: was.url, token: was.token }, to: { url: now.url, token: now.token } },
      secrets: { PEEL_BRIDGE_PORT: port(now), PEEL_BRIDGE_TOKEN: now.token },
    };
    await writeFile(join(to, MOVED_FILE), JSON.stringify(moved));
    return moved;
  }

  /** Boot on `dir` and check it reaches `now`, never `was`. */
  async function worksOn(dir: string, now: Bridge, was: Bridge[]) {
    const strut = await boot(dir);
    try {
      const store = strut.store as FileRunStore;
      assert.equal(await store.getRunCallback(WF, "1000"), runEnd(now));
      assert.equal(await store.getRunJobCallback(WF, "1000"), runEnd(now));
      assert.equal(await store.getRunCallback(stepRunKey("pack"), "2000"), runEnd(now));
      assert.deepEqual(await store.getRunMcp(WF, "1000"), [
        { name: "bridge", url: `${now.url}/mcp`, token: now.token },
        { name: "hive", url: "https://hive.test/mcp", token: "hive-token" },
      ]);
      const jobCallback = JSON.parse(await readFile(join(dir, "jobs", ".callbacks", "j1.json"), "utf-8")) as { url: string };
      assert.equal(jobCallback.url, runEnd(now));
      // The job keeps its files; its checkout is gone, and so is its record of it.
      const job = jobRoot(dir, "j1");
      assert.equal(await readFile(join(job, "plan.md"), "utf-8"), "the job's own file");
      assert.ok(!existsSync(join(job, "repo")), "the job's checkout is still there");
      assert.deepEqual((JSON.parse(await readFile(`${job}.json`, "utf-8")) as { repos: object }).repos, {});

      const secrets = new FileSecretStore(dir);
      assert.equal(await secrets.get("PEEL_BRIDGE_PORT"), port(now));
      assert.equal(await secrets.get("PEEL_BRIDGE_TOKEN"), now.token);
      assert.equal(await secrets.get("OTHER"), "kept");

      const upload = await savedAt(join(dir, "chats", "c1", "messages.jsonl"));
      assert.equal(upload, join(dir, "uploads", "c1", "note.txt"));
      assert.equal(await readFile(upload, "utf-8"), "hello from the mac");
      const attachment = await savedAt(join(dir, "sessions", "dm", "messages.jsonl"));
      assert.equal(attachment, join(dir, "artifacts", "1000", "attachments", "shot.txt"));
      assert.equal(await readFile(attachment, "utf-8"), "a run attachment");
      assert.equal((await readFile(join(dir, "chats", "c1", "messages.jsonl"), "utf-8")).split("\n").length, 3, "line count kept");

      // The automation's run.end goes to this host's bridge.
      const before = now.posts.length;
      const fired = await call(strut, "POST", `/workflows/${WF}/automations/${automation}/fire`);
      assert.equal(fired.status, 202, JSON.stringify(fired.json));
      for (let i = 0; i < 300 && now.posts.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(now.posts.slice(before), [`/bridge/run-end?token=${now.token}`]);
      for (const old of was) assert.ok(!old.posts.length, `${old.url} was posted to`);

      for (const rel of ["steps/_graph", "acp/sessions", "audio/dictation.json", "privacy/vault", "secrets.json.corrupt-2026", MOVED_FILE]) {
        assert.ok(!existsSync(join(dir, rel)), `${rel} is still there`);
      }
    } finally {
      await strut.close();
    }
  }

  it("Mac to box: every pointer and upload resolves on the box", async () => {
    await move(mac, box, macBridge, boxBridge);
    const result = await applyMove(box);
    assert.equal(result.applied, true);
    assert.ok(result.rewritten >= 8, JSON.stringify(result));
    await worksOn(box, boxBridge, [macBridge]);
  });

  it("applying the same move again changes nothing", async () => {
    const before = await tree(box);
    const moved: Moved = {
      from: mac,
      bridge: { from: { url: macBridge.url, token: macBridge.token }, to: { url: boxBridge.url, token: boxBridge.token } },
      secrets: { PEEL_BRIDGE_PORT: port(boxBridge), PEEL_BRIDGE_TOKEN: boxBridge.token },
    };
    await writeFile(join(box, MOVED_FILE), JSON.stringify(moved));
    assert.deepEqual(await applyMove(box), { applied: true, rewritten: 0, dropped: 0 });
    assert.deepEqual(await tree(box), before);
    assert.deepEqual(await applyMove(box), { applied: false, rewritten: 0, dropped: 0 }, "no moved.json, nothing to do");
  });

  it("box back to the Mac: the same rewrite the other way", async () => {
    await move(box, back, boxBridge, backBridge);
    await applyMove(back);
    await worksOn(back, backBridge, [macBridge]);
  });

  it("a moved.json it cannot read fails the boot", async () => {
    const dir = join(root, "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MOVED_FILE), JSON.stringify({ from: "relative/path" }));
    await assert.rejects(applyMove(dir), /moved\.json.*absolute path/s);
    await writeFile(join(dir, MOVED_FILE), JSON.stringify({ bridge: { from: { url: "http://x" } } }));
    await assert.rejects(applyMove(dir), /moved\.json/);
    assert.ok(existsSync(join(dir, MOVED_FILE)), "kept for the next try");
  });
});
