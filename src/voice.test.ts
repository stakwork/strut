// POST /voice/calls (src/voice.ts): a person's call handed to the voice
// service beside strut, against a stand-in service on a free port.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut, type Strut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { personToken } from "./auth.js";
import { VOICE_BODY_MAX, silentWav, voiceConfig, warmSpeech } from "./voice.js";
import type { SttService } from "./audio/stt.js";
import type { TtsService } from "./audio/tts.js";

const KEY = "voice-api-key";
const PEER_KEY = "voice-peer-key";
const SHARED = "voice-shared-token";
const NO_SEEDS = { serveUi: false, enableChat: false, scheduler: false, systemWorkflows: false, browserWorkflows: false, job: false, orchestrator: false, builder: false, privacyWorkflows: false } as const;

describe("POST /voice/calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-voice-"));
  const saved = { api: process.env["STRUT_API_KEY"], peer: process.env["STRUT_PEER_KEY"], url: process.env["STRUT_VOICE_URL"], token: process.env["STRUT_VOICE_TOKEN"] };
  // The stand-in voice service: what it was sent, and what it answers.
  let seen: { headers: http.IncomingHttpHeaders; body: Buffer; path?: string } | undefined;
  let answer = { status: 200, body: '{"room":"sphinx.call.voice.abc","token":"LIVEKIT-JWT-SENTINEL"}' };
  const service = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen = { headers: req.headers, body: Buffer.concat(chunks), path: req.url };
      res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
    });
  });
  let url = "";
  let strut: Strut;
  let n = 0;
  const boot = (voice?: { url: string; token: string } | false) =>
    createStrut({ workspace: new WorkspaceManager(join(dir, `ws-${n++}`)), store: new MemoryRunStore(), ...NO_SEEDS, ...(voice !== undefined ? { voice } : {}) });

  before(async () => {
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER_KEY;
    delete process.env["STRUT_VOICE_URL"];
    delete process.env["STRUT_VOICE_TOKEN"];
    await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(service.address() as AddressInfo).port}/`;
    strut = await boot({ url, token: SHARED });
  });
  after(async () => {
    await strut.close();
    service.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of [["STRUT_API_KEY", saved.api], ["STRUT_PEER_KEY", saved.peer], ["STRUT_VOICE_URL", saved.url], ["STRUT_VOICE_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  beforeEach(() => {
    seen = undefined;
    answer = { status: 200, body: '{"room":"sphinx.call.voice.abc","token":"LIVEKIT-JWT-SENTINEL"}' };
  });

  const call = (s: Strut, auth: string, body: string | Uint8Array = "{}", headers: Record<string, string> = {}) =>
    s.app.request("/voice/calls", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth}`, ...headers }, body });

  it("a person token's call goes to <url>/calls as its own actor, the body byte for byte, the shared token as the bearer", async () => {
    const body = '{ "key" : "S0VZLVNFTlRJTkVM" ,\n  "note": "ü" }';
    const res = await call(strut, personToken("tom-1")!.token, body, { "x-strut-actor": "mallory-9" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), answer.body);
    assert.equal(seen?.path, "/calls");
    assert.equal(seen?.headers["x-strut-actor"], "tom-1", "the token's actor, whatever the header says");
    assert.equal(seen?.headers["authorization"], `Bearer ${SHARED}`);
    assert.equal(seen?.headers["content-type"], "application/json");
    assert.ok(seen?.body.equals(Buffer.from(body)), "byte for byte");
  });

  it("the deployment key names the person with x-strut-actor, and without one is refused", async () => {
    const res = await call(strut, KEY, "{}", { "x-strut-actor": "evan-2" });
    assert.equal(res.status, 200);
    assert.equal(seen?.headers["x-strut-actor"], "evan-2");
    seen = undefined;
    const anon = await call(strut, KEY);
    assert.equal(anon.status, 403);
    assert.match(((await anon.json()) as { error: string }).error, /runs as a person/);
    assert.equal(seen, undefined, "never forwarded");
  });

  it("the plain peer key is 403, no credential (or one strut cannot verify) is 401", async () => {
    assert.equal((await call(strut, PEER_KEY, "{}", { "x-strut-actor": "tom-1" })).status, 403);
    assert.equal((await call(strut, "nope")).status, 401);
    assert.equal((await strut.app.request("/voice/calls", { method: "POST", body: "{}" })).status, 401);
    assert.equal(seen, undefined);
  });

  it("the service's status and body come back unchanged — a 402 stays a 402", async () => {
    answer = { status: 402, body: '{"error":"balance below the minimum","balance":3,"minimum":10}' };
    const res = await call(strut, personToken("tom-1")!.token);
    assert.equal(res.status, 402);
    assert.equal(await res.text(), answer.body);
  });

  it("a body over the cap is 413 and never forwarded", async () => {
    const res = await call(strut, personToken("tom-1")!.token, JSON.stringify({ key: "x".repeat(VOICE_BODY_MAX) }));
    assert.equal(res.status, 413);
    assert.equal(seen, undefined);
  });

  it("no voice service configured, or one not answering, is 503 — and nothing of the call is logged", async () => {
    const off = await boot(false);
    const none = await call(off, personToken("tom-1")!.token);
    assert.equal(none.status, 503);
    assert.match(((await none.json()) as { error: string }).error, /STRUT_VOICE_URL/);
    await off.close();

    const gone = http.createServer();
    await new Promise<void>((r) => gone.listen(0, "127.0.0.1", r));
    const port = (gone.address() as AddressInfo).port;
    await new Promise<void>((r) => gone.close(() => r()));
    const down = await boot({ url: `http://127.0.0.1:${port}`, token: SHARED });
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const res = await call(down, personToken("tom-1")!.token, '{"key":"S0VZLVNFTlRJTkVM"}');
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.doesNotMatch(text, /S0VZLVNFTlRJTkVM/);
      assert.equal((await call(strut, personToken("tom-1")!.token, '{"key":"S0VZLVNFTlRJTkVM"}')).status, 200);
    } finally {
      Object.assign(console, orig);
      await down.close();
    }
    assert.ok(!lines.some((l) => /S0VZLVNFTlRJTkVM|LIVEKIT-JWT-SENTINEL|voice-shared-token/.test(l)), lines.join("\n"));
  });

  it("config: the option wins over the env, false turns it off, and half a configuration fails the boot", async () => {
    assert.equal(voiceConfig(undefined, {}), undefined);
    assert.deepEqual(voiceConfig(undefined, { STRUT_VOICE_URL: "http://127.0.0.1:7881/", STRUT_VOICE_TOKEN: "t" }), { url: "http://127.0.0.1:7881", token: "t" });
    assert.equal(voiceConfig(false, { STRUT_VOICE_URL: "http://127.0.0.1:7881", STRUT_VOICE_TOKEN: "t" }), undefined);
    assert.deepEqual(voiceConfig({ url: "https://voice.internal", token: "o" }, { STRUT_VOICE_URL: "http://x", STRUT_VOICE_TOKEN: "t" }), { url: "https://voice.internal", token: "o" });
    assert.throws(() => voiceConfig(undefined, { STRUT_VOICE_URL: "http://127.0.0.1:7881" }), /STRUT_VOICE_TOKEN/);
    assert.throws(() => voiceConfig(undefined, { STRUT_VOICE_URL: "ftp://x", STRUT_VOICE_TOKEN: "t" }), /http\(s\)/);
    assert.throws(() => voiceConfig({ url: "", token: "t" }, {}), /http\(s\)/);
    process.env["STRUT_VOICE_URL"] = "http://127.0.0.1:7881";
    try {
      await assert.rejects(boot(), /STRUT_VOICE_TOKEN/);
    } finally {
      delete process.env["STRUT_VOICE_URL"];
    }
  });
});

describe("the speech a call uses is warmed when strut starts", () => {
  /** Stand-in speech services: what each was asked, and how it answers. */
  const fakes = (o: { sttFails?: boolean } = {}) => {
    const seen = { wavs: [] as Uint8Array[], said: [] as string[], drained: 0 };
    let warmed!: () => void;
    const done = new Promise<void>((r) => (warmed = r));
    let left = 2;
    const tick = () => void (--left === 0 && warmed());
    const stt = {
      fixer: { warm: async () => {} },
      async transcribe(wav: Uint8Array) {
        seen.wavs.push(wav);
        tick();
        if (o.sttFails) throw new Error("no recognizer here");
        return { text: "", segments: [], model: "zipformer-en-kroko", hotwords: null, durationMs: 1 };
      },
    };
    const tts = {
      async speak(text: string) {
        seen.said.push(text);
        return {
          model: "kokoro-en-v1.0",
          voice: "af_heart",
          sampleRate: 24000,
          audio: (async function* () {
            yield new Uint8Array(4);
            seen.drained++;
            tick();
          })(),
        };
      },
    };
    return { seen, done, stt: stt as unknown as SttService, tts: tts as unknown as TtsService };
  };

  it("transcribes half a second of 16 kHz silence and drains one short speech, and a failure is a log line", async () => {
    const f = fakes({ sttFails: true });
    const lines: string[] = [];
    await warmSpeech({ stt: f.stt, tts: f.tts, log: (m) => lines.push(m) });
    const wav = f.seen.wavs[0]!;
    assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
    assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000);
    assert.equal(wav.length, 44 + 16000);
    assert.deepEqual(wav, silentWav());
    assert.deepEqual(f.seen.said, ["Hello."]);
    assert.equal(f.seen.drained, 1);
    assert.ok(lines.some((l) => /speech recognition did not warm up: no recognizer here/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /^speech ready for calls/.test(l)), lines.join("\n"));
    await warmSpeech({ stt: null, tts: null, log: () => {} });
  });

  it("listen() warms them with a voice service configured, and not without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-voice-warm-"));
    const savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    const boot = (voice: { url: string; token: string } | false, f: ReturnType<typeof fakes>) =>
      createStrut({ workspace: new WorkspaceManager(join(dir, voice ? "on" : "off")), store: new MemoryRunStore(), ...NO_SEEDS, voice, stt: f.stt, tts: f.tts });
    const on = fakes();
    const off = fakes();
    const withVoice = await boot({ url: "http://127.0.0.1:1", token: SHARED }, on);
    const without = await boot(false, off);
    try {
      await withVoice.listen(0, "127.0.0.1");
      await without.listen(0, "127.0.0.1");
      await on.done;
      assert.equal(on.seen.wavs.length, 1);
      assert.deepEqual(on.seen.said, ["Hello."]);
      assert.deepEqual([off.seen.wavs.length, off.seen.said.length], [0, 0]);
    } finally {
      await withVoice.close();
      await without.close();
      if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = savedKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
