/**
 * `strut move`: the sealing (peel's test vector, byte for byte), and a move
 * between two data folders in both directions — send to a `serve` on an
 * empty host, then `serve --send-back` and `fetch` home again — with a
 * sidecar, env values, a wrong code and a version mismatch.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { applyMove, leftBehind, MOVED_FILE } from "../moved.js";
import { moveVersion, type MoveFolders } from "./archive.js";
import { check, fetchMove, send } from "./client.js";
import { main } from "./cli.js";
import { makeLink, parseLink } from "./link.js";
import { hkdf, open, proof, seal, WrongCode } from "./seal.js";
import { serve, type ServeOptions, type ServeResult } from "./serve.js";

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
    assert.equal(hex(hkdf(code, salt, "peel home move v1")), "13e289b08266d671425a9a52bda8afb069d9f07bcd9f334f3a1772075cad5806");
    const sealed = await collect(seal(bytes(Buffer.from("hello")), code, { salt }));
    assert.equal(hex(sealed), "5045454c4d4f564501000102030405060708090a0b0c0d0e0f00100000" + "79d992f92d83c0104c5a817ed89e3d24e6077d47d4");
    assert.equal(hex(proof(code, salt, "check")), "c8a6db5727d4059357349a2e07740712748984c33a5f7610aa08d8310d8e56b5");
    assert.equal(hex(proof(code, salt, "received")), "f46ee2a084e910283e7e5b08d4eee0ec168196603a094f63adb45738d2c5b3ce");
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
    await put(macFolders.data, {
      "secrets.json": '{"salt":"x","secrets":{}}',
      "graph/graph.lbug": randomBytes(300_000),
      "graph/graph.lbug.wal": randomBytes(1000),
      "chats/c1/messages.jsonl": `{"role":"user","content":"saved at ${macFolders.data}/uploads/c1/a.txt"}\n`,
      "uploads/c1/a.txt": "hello",
      "jobs/j1.json": "{}",
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
    sourceData = new Map([...(await tree(macFolders.data))].filter(([rel]) => !rel.split("/").some((_, i, parts) => leftBehind(parts.slice(0, i + 1).join("/"), i < parts.length - 1))));
    assert.ok(sourceData.has("graph/graph.lbug") && !sourceData.has("jobs/j1/repo/README") && !sourceData.has(MOVED_FILE) && sourceData.has("jobs/.callbacks/j1.json"));
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
    assert.ok(existsSync(join(box, "strut", sent[0]!, "data", "graph", "graph.lbug")));
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

  it("the CLI: usage is exit 2, a refusal exit 1", async () => {
    assert.equal(await main(["nope"]), 2);
    assert.equal(await main(["check", "http://127.0.0.1:1/?code=ABCD"]), 1);
  });
});
