/**
 * `strut move`: the sealing (the test vector a client checks itself against), and a move
 * between two data folders in both directions — send to a `serve` on an
 * empty host, then `serve --send-back` and `fetch` home again — with a
 * sidecar, env values, a wrong code and a version mismatch.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { applyMove, leftBehindIn, MOVED_FILE } from "../moved.js";
import { moveVersion, packFolders, unpack, type MoveFolders } from "./archive.js";
import { check, fetchMove, send } from "./client.js";
import { main } from "./cli.js";
import { makeLink, parseLink } from "./link.js";
import { hkdf, open, proof, seal, WrongCode } from "./seal.js";
import { serve, type MovePeer, type ServeOptions, type ServeResult } from "./serve.js";
import { verifyPersonToken } from "../auth.js";
import { checkPeer } from "../peers.js";
import { loadLadybug, openLadybug } from "../graph/ladybug/db.js";
import { pinnedExtensions } from "../graph/ladybug/extensions.js";
import { testBackends } from "../graph/test-util.js";

const hex = (b: Buffer) => b.toString("hex");

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of it) parts.push(b);
  return Buffer.concat(parts);
}

async function* bytes(b: Buffer): AsyncGenerator<Buffer> {
  for (let i = 0; i < b.length; i += 7777) yield b.subarray(i, i + 7777);
}

describe("move sealing", () => {
  const code = "0123456789ABCDEFGHJK";
  const salt = Buffer.from([...Array(16).keys()]);

  it("matches the test vector", async () => {
    assert.equal(hex(hkdf(code, salt, "strut move v1")), "f3a18e07fda9966e92eff467d835e7739f79b4ed26206d27ac0e3ea87327c04c");
    const sealed = await collect(seal(bytes(Buffer.from("hello")), code, { salt }));
    assert.equal(hex(sealed), "53545255544d4f5601000102030405060708090a0b0c0d0e0f00100000" + "38813acee60021f1c15a2f4664971ccc9b488b20e0");
    assert.equal(hex(proof(code, salt, "check")), "634cebd16b58814fefba4143d35500ba578cfbcf42d008c4e4415ede58e0fdae");
    assert.equal(hex(proof(code, salt, "received")), "e8efb462a00edda9dd6edaf9e5fa763abbacf244a30bde9e192fbe690662098d");
    assert.equal((await collect(open(bytes(sealed), code))).toString(), "hello");
  });

  it("opens many chunks, and refuses a wrong code, a cut, reordering and trailing bytes", async () => {
    const plain = randomBytes(65536 * 3 + 100);
    const sealed = await collect(seal(bytes(plain), code, { chunk: 65536 }));
    assert.ok((await collect(open(bytes(sealed), code))).equals(plain));
    const exact = randomBytes(65536 * 2);
    assert.ok((await collect(open(bytes(await collect(seal(bytes(exact), code, { chunk: 65536 }))), code))).equals(exact), "a whole last chunk, then an empty final one");
    assert.equal((await collect(open(bytes(await collect(seal(bytes(Buffer.alloc(0)), code))), code))).length, 0);

    await assert.rejects(collect(open(bytes(sealed), "ABCDEFGHJK0123456789")), WrongCode);
    await assert.rejects(collect(open(bytes(sealed.subarray(0, sealed.length - 50)), code)), /damaged or cut short/);
    await assert.rejects(collect(open(bytes(sealed.subarray(0, 29 + 65552 * 2)), code)), /damaged or cut short/, "cut at a chunk boundary");
    await assert.rejects(collect(open(bytes(Buffer.concat([sealed, Buffer.from("x")])), code)), /damaged or cut short/);
    const record = 65536 + 16;
    const swapped = Buffer.concat([sealed.subarray(0, 29), sealed.subarray(29 + record, 29 + 2 * record), sealed.subarray(29, 29 + record), sealed.subarray(29 + 2 * record)]);
    await assert.rejects(collect(open(bytes(swapped), code)), WrongCode);
    await assert.rejects(collect(open(bytes(Buffer.from("not a move at all, clearly not")), code)), /not a move/);
  });

  it("links: plain and with a client's scheme", () => {
    assert.deepEqual(parseLink(makeLink("10.0.0.5:8090", "ABCD")), { base: "http://10.0.0.5:8090", code: "ABCD" });
    const peel = makeLink("box.local:8090", "0123456789ABCDEFGHJK", "peel://home-setup");
    assert.equal(peel, "peel://home-setup?host=box.local%3A8090&code=0123456789ABCDEFGHJK");
    assert.deepEqual(parseLink(peel), { base: "http://box.local:8090", code: "0123456789ABCDEFGHJK" });
    assert.equal(parseLink("peel://home-setup?host=b:1&code=0123-4567-89ab-cdef-ghjk").code, "0123456789ABCDEFGHJK");
    assert.throws(() => parseLink("peel://home-setup?code=X"), /names no host/);
  });
});

/** Every file under `dir` with its bytes, `/`-separated. */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await readdir(dir, { recursive: true })) {
    const path = join(dir, name);
    if ((await stat(path)).isFile()) out.set(relative(dir, path).split("\\").join("/"), hex(await readFile(path)));
  }
  return out;
}

async function put(dir: string, files: Record<string, string | Buffer>) {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
}

/** Run `serve` and hand back its link once it is up. */
function serving(o: ServeOptions): { ready: Promise<string>; done: Promise<ServeResult> } {
  let ready!: (link: string) => void;
  const r = new Promise<string>((res) => (ready = res));
  const done = serve({ host: "127.0.0.1", port: 0, ...o, onReady: ({ link }) => ready(link) });
  return { ready: Promise.race([r, done.then((x) => Promise.reject(new Error(`serve ended: ${x}`)))]), done };
}

describe("a move between two hosts and back", () => {
  const root = join(tmpdir(), `strut-move-${randomUUID()}`);
  const mac = join(root, "mac", "Library", "Application Support", "Peel");
  const box = join(root, "box", "data");
  const back = join(root, "mac2", "Peel");
  const macFolders: MoveFolders = {
    data: join(mac, "Strut", "workspace"),
    hostConfig: join(mac, "Strut", "host-config.json"),
    sidecars: { bridge: join(mac, "Bridge") },
    envFile: join(mac, "move.env"),
  };
  const boxFolders: MoveFolders = {
    data: join(box, "strut", "workspace"),
    hostConfig: join(box, "strut", "host-config.json"),
    sidecars: { bridge: join(box, "bridge") },
    envFile: join(box, "strut.env"),
    sidecarEnv: { bridge: join(box, "bridge.env") },
  };
  const backFolders: MoveFolders = {
    data: join(back, "Strut", "workspace"),
    hostConfig: join(back, "Strut", "host-config.json"),
    sidecars: { bridge: join(back, "Bridge") },
    envFile: join(back, "strut.env"),
    sidecarEnv: { bridge: join(back, "bridge.env") },
  };
  const macBridge = { url: "http://127.0.0.1:54321", token: "mac-token" };
  const boxBridge = { url: "http://127.0.0.1:8000", token: "box-token" };
  const backBridge = { url: "http://127.0.0.1:61000", token: "back-token" };
  const secrets = { PEEL_BRIDGE_PORT: "{bridge.port}", PEEL_BRIDGE_TOKEN: "{bridge.token}" };
  let sourceData: Map<string, string>;

  before(async () => {
    const jobRecord = {
      name: "j1",
      usedAt: "2026-10-26T00:00:00.000Z",
      repos: { [join(macFolders.data, "jobs", "j1", "repo")]: { cache: join(macFolders.data, "repos", "acme", "repo.git"), ref: "main" } },
    };
    await put(macFolders.data, {
      "secrets.json": '{"salt":"x","secrets":{}}',
      // Opaque bytes: the memory graph moves as files (the workspace graph is
      // checkpointed first, which needs a real one: below).
      "memory/graph.lbug": randomBytes(300_000),
      "memory/graph.lbug.wal": randomBytes(1000),
      "chats/c1/messages.jsonl": `{"role":"user","content":"saved at ${macFolders.data}/uploads/c1/a.txt"}\n`,
      "uploads/c1/a.txt": "hello",
      // A job: its record, its own file, and a checkout its record lists.
      "jobs/j1.json": JSON.stringify(jobRecord, null, 2),
      "jobs/j1/plan.md": "the job's own file",
      "jobs/.callbacks/j1.json": '{"url":"http://127.0.0.1:54321/x?token=mac-token"}',
      "empty.txt": "",
      // Left behind:
      "jobs/j1/repo/README": "a checkout",
      "steps/_graph/x/index.ts": "rebuilt",
      "acp/sessions/s.json": "{}",
      "audio/dictation.json": "{}",
      "secrets.json.corrupt-1": "x",
      "runs.json.tmp": "x",
      [MOVED_FILE]: "{}",
    });
    await put(mac, {
      "Strut/host-config.json": '{"orchestrator":{"tools":["x"]}}',
      "Strut/cache/model.bin": "rebuilt, not moved",
      "Bridge/db.redb": randomBytes(5000),
      "Bridge/sub/notes": "opaque",
      "move.env": "STRUT_SECRET_KEY=s3cret key\nSTRUT_API_KEY=host-bound\n# a comment\nbridge.BROKER_URL=broker:1883\nbridge.RUNNER_ALIAS=It's me\n",
    });
    const left = await leftBehindIn(macFolders.data);
    sourceData = new Map([...(await tree(macFolders.data))].filter(([rel]) => !rel.split("/").some((_, i, parts) => left(parts.slice(0, i + 1).join("/"), i < parts.length - 1))));
    assert.ok(sourceData.has("memory/graph.lbug") && !sourceData.has(MOVED_FILE) && sourceData.has("jobs/.callbacks/j1.json"));
    assert.ok(sourceData.has("jobs/j1/plan.md") && !sourceData.has("jobs/j1/repo/README"), "a job's files move, its checkouts do not");
    // This folder has a moved.json of its own, applied before it packs: the
    // job's record forgets the checkout there.
    sourceData.set("jobs/j1.json", hex(Buffer.from(JSON.stringify({ ...jobRecord, repos: {} }, null, 2))));
  });

  after(() => rm(root, { recursive: true, force: true }));

  it("an empty host refuses a wrong code and another strut version, then takes the move", async () => {
    const box1 = serving({ ...boxFolders, bridge: boxBridge, secrets });
    const link = await box1.ready;
    const info = await check(link);
    assert.deepEqual([info.mode, info.format], ["receive", 1]);

    const wrong = link.replace(/code=\w+/, "code=ABCDEFGHJKMNPQRSTVWX");
    await assert.rejects(check(wrong), /code was refused.*check the code/);
    await assert.rejects(send(wrong, macFolders, { bridge: macBridge }), /code was refused/);
    // A move sealed with another code, sent without asking first.
    const { base } = parseLink(link);
    const res = await fetch(`${base}/move`, {
      method: "PUT",
      body: Readable.toWeb(Readable.from(seal(bytes(Buffer.from("x")), "ABCDEFGHJKMNPQRSTVWX"))) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    assert.equal(res.status, 401);
    await assert.rejects(check(link, { version: { ...moveVersion(), strut: "0.0.0-other" } }), /versions differ/);
    await assert.rejects(check(link, { expect: "send-back" }), /waiting to receive/);

    const manifest = await send(link, macFolders, { bridge: macBridge });
    assert.equal(await box1.done, "received");
    assert.deepEqual(manifest.sidecars, ["bridge"]);

    // Byte for byte, but for what is left behind and the moved.json it gains.
    const got = await tree(boxFolders.data);
    const moved = JSON.parse(Buffer.from(got.get(MOVED_FILE)!, "hex").toString());
    got.delete(MOVED_FILE);
    assert.deepEqual(got, sourceData);
    assert.deepEqual(moved, {
      from: macFolders.data,
      bridge: { from: macBridge, to: boxBridge },
      secrets: { PEEL_BRIDGE_PORT: "8000", PEEL_BRIDGE_TOKEN: "box-token" },
    });
    assert.deepEqual(await tree(boxFolders.sidecars!["bridge"]!), await tree(macFolders.sidecars!["bridge"]!));
    assert.equal(await readFile(boxFolders.hostConfig!, "utf-8"), await readFile(macFolders.hostConfig!, "utf-8"));
    assert.equal(await readFile(boxFolders.envFile!, "utf-8"), "STRUT_SECRET_KEY='s3cret key'\n", "strut's own keys, minus the host's");
    assert.equal(await readFile(boxFolders.sidecarEnv!["bridge"]!, "utf-8"), "BROKER_URL='broker:1883'\nRUNNER_ALIAS='It'\\''s me'\n");
    assert.ok(!existsSync(join(box, "strut", "cache")));
  });

  it("a host that has strut serves nothing unless asked to send it back", async () => {
    assert.equal(await serve({ ...boxFolders, port: 0 }), "already-here");
  });

  it("sends it back: fetch puts it in place, and the box sets its copy aside", async () => {
    // The box's strut never booted: its moved.json is applied when it packs.
    assert.ok(existsSync(join(boxFolders.data, MOVED_FILE)));
    const boxSidecar = await tree(boxFolders.sidecars!["bridge"]!);
    const box2 = serving({ ...boxFolders, bridge: boxBridge, sendBack: true });
    const link = await box2.ready;
    assert.equal((await check(link)).mode, "send-back");
    await assert.rejects(fetchMove(link.replace(/code=\w+/, "code=ABCDEFGHJKMNPQRSTVWX"), backFolders), /code was refused/);

    await fetchMove(link, backFolders, { bridge: backBridge, secrets });
    assert.equal(await box2.done, "sent");

    const got = await tree(backFolders.data);
    const moved = JSON.parse(Buffer.from(got.get(MOVED_FILE)!, "hex").toString());
    got.delete(MOVED_FILE);
    // Home again: byte for byte, but for what the box's moved.json rewrote
    // (the callback, the upload path and the bridge secrets: the box's,
    // which this Mac's own moved.json rewrites in turn).
    const changed = [...got.keys()].filter((k) => got.get(k) !== sourceData.get(k)).sort();
    assert.deepEqual(changed, ["chats/c1/messages.jsonl", "jobs/.callbacks/j1.json", "secrets.json"]);
    assert.deepEqual([...got.keys()].sort(), [...sourceData.keys()].sort());
    assert.deepEqual(JSON.parse(Buffer.from(got.get("jobs/j1.json")!, "hex").toString()).repos, {});
    assert.deepEqual(moved, {
      from: boxFolders.data,
      bridge: { from: boxBridge, to: backBridge },
      secrets: { PEEL_BRIDGE_PORT: "61000", PEEL_BRIDGE_TOKEN: "back-token" },
    });
    assert.deepEqual(await tree(backFolders.sidecars!["bridge"]!), boxSidecar);
    assert.equal(await readFile(backFolders.envFile!, "utf-8"), "STRUT_SECRET_KEY='s3cret key'\n");
    assert.equal(await readFile(backFolders.sidecarEnv!["bridge"]!, "utf-8"), "BROKER_URL='broker:1883'\nRUNNER_ALIAS='It'\\''s me'\n");

    // The box is empty again, its copy set aside.
    for (const p of [boxFolders.data, boxFolders.sidecars!["bridge"]!, boxFolders.envFile!, boxFolders.hostConfig!]) assert.ok(!existsSync(p), `${p} is still there`);
    // Beside the data folder: <data's parent>/sent-<time>/.
    const sent = (await readdir(join(box, "strut"))).filter((n) => n.startsWith("sent-"));
    assert.equal(sent.length, 1);
    assert.ok(existsSync(join(box, "strut", sent[0]!, "data", "memory", "graph.lbug")));
    assert.ok(existsSync(join(box, "strut", sent[0]!, "sidecars", "bridge", "db.redb")));

    // strut's next boot applies it.
    assert.equal((await applyMove(backFolders.data)).applied, true);
    const chat = await readFile(join(backFolders.data, "chats", "c1", "messages.jsonl"), "utf-8");
    assert.ok(chat.includes(`${backFolders.data}/uploads/c1/a.txt`), chat);
  });

  it("a move whose sidecars are not the host's is refused", async () => {
    const other = join(root, "other");
    const box3 = serving({ data: join(other, "workspace") });
    const link = await box3.ready;
    await assert.rejects(send(link, macFolders), /sidecars \(bridge\) are not this host's \(none\)/);
    assert.ok(!existsSync(join(other, "workspace", "secrets.json")));
    await send(link, { data: macFolders.data });
    assert.equal(await box3.done, "received");
  });

  it("asked for one, a landed move hands back a peer record: this strut's address, a person token it verifies, its CA", async () => {
    const saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = "the-box-strut-key";
    try {
      const other = join(root, "peered");
      await mkdir(other, { recursive: true });
      await writeFile(join(other, "ca.pem"), "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
      const box5 = serving({ data: join(other, "workspace"), peer: { url: "https://{host}:8443/", ca: join(other, "ca.pem"), servername: "peel-home", days: 30 } });
      const link = await box5.ready;
      const sent = await send(link, { data: macFolders.data }, { peerActor: "tom" });
      assert.equal(await box5.done, "received");
      const peer = sent.peer as MovePeer;
      assert.equal(peer.baseUrl, "https://127.0.0.1:8443", "{host} is the address the move came in on");
      assert.equal(peer.actor, "tom");
      assert.equal(peer.ca, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
      assert.equal(peer.servername, "peel-home", "the name the box's certificate is issued for");
      assert.deepEqual(verifyPersonToken(peer.token), { actor: "tom", exp: peer.exp }, "the strut that arrived verifies it");
      assert.ok(peer.exp > Date.now() + 29 * 86_400_000 && peer.exp < Date.now() + 31 * 86_400_000);
      // Put on file as a peer, it is a valid record.
      assert.equal(checkPeer({ id: "home", baseUrl: peer.baseUrl, token: peer.token, ca: peer.ca, servername: peer.servername }).servername, "peel-home");

      // Not asked: no record. Asked of a host that gives none: why not.
      const box6 = serving({ data: join(other, "plain") });
      assert.equal((await send(await box6.ready, { data: macFolders.data })).peer, undefined);
      await box6.done;
      const box7 = serving({ data: join(other, "plain2") });
      assert.match((await send(await box7.ready, { data: macFolders.data }, { peerActor: "tom" })).peer!.error!, /no peer record/);
      await box7.done;
    } finally {
      if (saved === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = saved;
    }
  });

  it("a move that fails while it is put in place leaves the host as it was", async () => {
    const other = join(root, "half");
    const locked = join(other, "locked");
    await mkdir(locked, { recursive: true });
    await writeFile(join(other, "strut.env"), "BEFORE='1'\n");
    const folders: MoveFolders = {
      data: join(other, "workspace"),
      hostConfig: join(other, "host-config.json"),
      // The sidecar's place cannot be made: its parent is read-only.
      sidecars: { bridge: join(locked, "bridge") },
      envFile: join(other, "strut.env"),
    };
    await chmod(locked, 0o500);
    const box4 = serving(folders);
    try {
      const link = await box4.ready;
      await assert.rejects(send(link, macFolders), /the move was refused: EACCES/);
      assert.ok(!existsSync(folders.data), "the workspace was taken back");
      assert.ok(!existsSync(folders.hostConfig!), "the host config was taken back");
      assert.equal(await readFile(folders.envFile!, "utf-8"), "BEFORE='1'\n");
      // Still serving: once the place can be made, the same code works.
      await chmod(locked, 0o700);
      await send(link, macFolders);
      assert.equal(await box4.done, "received");
      assert.ok(existsSync(join(folders.data, "memory", "graph.lbug")) && existsSync(join(locked, "bridge", "db.redb")));
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("the CLI: usage is exit 2, a refusal exit 1", async () => {
    assert.equal(await main(["nope"]), 2);
    assert.equal(await main(["check", "http://127.0.0.1:1/?code=ABCD"]), 1);
  });
});

describe("a job moves with its files, never its checkouts", () => {
  const root = join(tmpdir(), `strut-move-job-${randomUUID()}`);
  after(() => rm(root, { recursive: true, force: true }));

  it("packs the job's own files, leaves the checkout its record lists, and arrival forgets it", async () => {
    const data = join(root, "mac", "workspace");
    const checkout = join(data, "jobs", "j1", "repo");
    const record = { name: "j1", usedAt: "2026-10-26T00:00:00.000Z", repos: { [checkout]: { cache: join(data, "repos", "acme", "repo.git"), ref: "main" } } };
    await put(data, {
      "jobs/j1.json": JSON.stringify(record, null, 2),
      "jobs/j1/plan.md": "the job's own file",
      "jobs/j1/shots/001.png": randomBytes(100),
      "jobs/j1/repo/.git": "gitdir: elsewhere\n",
      "jobs/j1/repo/README": "a checkout",
    });
    const into = join(root, "unpacked");
    await unpack((await packFolders({ data })).plain, into);
    assert.deepEqual([...(await tree(join(into, "data"))).keys()].sort(), ["jobs/j1.json", "jobs/j1/plan.md", "jobs/j1/shots/001.png"]);
    assert.ok(existsSync(join(checkout, "README")), "the sender keeps its checkout");

    // The record names the sender's path; arrival's moved.json forgets it.
    await writeFile(join(into, "data", MOVED_FILE), JSON.stringify({ from: data }));
    assert.equal((await applyMove(join(into, "data"))).applied, true);
    assert.deepEqual(JSON.parse(await readFile(join(into, "data", "jobs", "j1.json"), "utf-8")), { ...record, repos: {} });
  });
});

/** A child that opens the workspace graph with the extensions in `dir` and
 *  writes a node with search text and an embedding. With `die`, it exits
 *  without closing the graph, as a killed strut (or a container stopped
 *  without a handler) does: the WAL stays, and on a graph that already
 *  existed it names `dir` (the session that creates a file logs no load). */
function writeIn(file: string, dir: string, ref: string, die: boolean): void {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { openLadybug } from ${JSON.stringify(fileURLToPath(new URL("../graph/ladybug/db.js", import.meta.url)))};
       const h = await openLadybug(${JSON.stringify(file)}, { extensionDir: ${JSON.stringify(dir)} });
       const v = Array.from({ length: 384 }, (_, i) => (i % 11) / 11);
       await h.withWrite((tx) => tx.run("CREATE (:Node {ref_id: $r, name: $r, Data_Bank: 'remember the lighthouse keeper', text_embeddings: $v})", { r: ${JSON.stringify(ref)}, v }));
       ${die ? "process.exit(0);" : "await h.close();"}`,
    ],
    { env: process.env, encoding: "utf-8" },
  );
  assert.equal(child.status, 0, child.stderr);
  if (die) assert.ok(existsSync(`${file}.wal`), "the child left a WAL");
}

describe("a graph written on one host opens on another", { skip: testBackends().find((b) => b.kind === "ladybug")!.skip }, () => {
  const root = join(tmpdir(), `strut-move-graph-${randomUUID()}`);
  const ext = (name: string) => join(root, `ext-${name}`);
  const mac = { data: join(root, "mac", "workspace") };
  const box = { data: join(root, "box", "workspace") };
  const back = { data: join(root, "back", "workspace") };
  const graphOf = (f: { data: string }) => join(f.data, "graph", "graph.lbug");
  const saved = process.env["STRUT_LADYBUG_EXTENSION_DIR"];

  /** This host's extensions: strut's pinned files, copied into a folder of its own. */
  async function extensions(name: string): Promise<string> {
    const pinned = await pinnedExtensions((await loadLadybug()).Database.getVersion());
    assert.ok("files" in pinned, "files" in pinned ? "" : pinned.none);
    await mkdir(ext(name), { recursive: true });
    for (const [n, path] of Object.entries(pinned.files)) await copyFile(path, join(ext(name), `lib${n}.lbug_extension`));
    return ext(name);
  }

  /** The nodes `refs` are found by full text and by vector. */
  async function searchable(file: string, dir: string, refs: string[]) {
    const h = await openLadybug(file, { extensionDir: dir });
    try {
      const fts = await h.query("CALL QUERY_FTS_INDEX('Node', 'node_fts', 'lighthouse') RETURN node.ref_id AS r");
      assert.deepEqual(fts.map((r) => r["r"]).sort(), [...refs].sort());
      const v = Array.from({ length: 384 }, (_, i) => (i % 11) / 11);
      const near = await h.query("CALL QUERY_VECTOR_INDEX('Node', 'node_vec', $v, 5) RETURN node.ref_id AS r", { v });
      assert.deepEqual(near.map((r) => r["r"]).sort(), [...refs].sort());
    } finally {
      await h.close();
    }
  }

  after(async () => {
    if (saved === undefined) delete process.env["STRUT_LADYBUG_EXTENSION_DIR"];
    else process.env["STRUT_LADYBUG_EXTENSION_DIR"] = saved;
    await rm(root, { recursive: true, force: true });
  });

  it("a graph copied with its WAL fails where the writer's extension path is missing", async () => {
    const a = await extensions("raw");
    const file = join(root, "raw", "graph.lbug");
    writeIn(file, a, "r0", false);
    writeIn(file, a, "r1", true);
    await cp(join(root, "raw"), join(root, "raw-copy"), { recursive: true });
    await rename(a, `${a}-gone`);
    const b = await extensions("raw-b");
    await assert.rejects(openLadybug(join(root, "raw-copy", "graph.lbug"), { extensionDir: b }), new RegExp(`Failed to load library: ${a}/`));
  });

  it("moves both ways: each sender folds the WAL in, so the graph opens with the next host's extensions", async () => {
    // The Mac: extensions in A, a graph written, then left with its WAL.
    const a = await extensions("A");
    writeIn(graphOf(mac), a, "mac0", false);
    writeIn(graphOf(mac), a, "mac", true);
    const toBox = serving(box);
    process.env["STRUT_LADYBUG_EXTENSION_DIR"] = a; // the sender's own
    await send(await toBox.ready, mac);
    assert.equal(await toBox.done, "received");
    assert.ok(!existsSync(`${graphOf(box)}.wal`), "no WAL travels");
    await rm(a, { recursive: true });

    // The box: its own extensions in B; it writes too, and is stopped hard.
    const b = await extensions("B");
    writeIn(graphOf(box), b, "box", true);
    const home = serving({ ...box, sendBack: true });
    process.env["STRUT_LADYBUG_EXTENSION_DIR"] = b;
    await fetchMove(await home.ready, back);
    assert.equal(await home.done, "sent");
    assert.ok(!existsSync(`${graphOf(back)}.wal`), "no WAL travels");
    await rm(b, { recursive: true });

    // Home again, with extensions in C: everything written on both hosts is searchable.
    await searchable(graphOf(back), await extensions("C"), ["mac0", "mac", "box"]);
  });
});
