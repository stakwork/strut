// Voice calls (plans/private-voice.md §4.1). `POST /voice/calls` hands a
// person's call to the voice service beside strut (`STRUT_VOICE_URL`,
// `createStrut({ voice })`): the body as it came, the person as
// `x-strut-actor`, the secret the two share as the bearer, and the service's
// answer back as it came. Strut only says who the call is for.
//
// A route, not a workflow: the body and the answer carry the call's key and
// room tokens, and a run records its input and output where every peer scope
// may read them. Nothing here logs or keeps either, and no error echoes them.
//
// A strut with a voice service warms the speech its calls use when it starts
// (`warmSpeech`, from `listen()`): the recognizer and Kokoro are downloaded
// on first use and loaded on the first request after a start, and a call's
// first turn would otherwise wait for both.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SttService } from "./audio/stt.js";
import type { TtsService } from "./audio/tts.js";

export interface VoiceConfig {
  /** The voice service's base URL; the call goes to `<url>/calls`. */
  url: string;
  /** The secret strut and the voice service share, sent as the bearer. */
  token: string;
}

/** The route (createStrut's gate admits a person's token to it). */
export const VOICE_CALLS = "/voice/calls";
/** The largest body a call set-up carries: a key, or a sealed envelope. */
export const VOICE_BODY_MAX = 16 * 1024;
const VOICE_TIMEOUT_MS = 15_000;

/** The voice service from `createStrut({ voice })`, else from
 *  STRUT_VOICE_URL + STRUT_VOICE_TOKEN; `false` or no URL: none. A URL that
 *  is not http(s), or one with no token, fails the boot. */
export function voiceConfig(opt: VoiceConfig | false | undefined, env: NodeJS.ProcessEnv): VoiceConfig | undefined {
  if (opt === false) return undefined;
  const { url, token } = opt ?? { url: env["STRUT_VOICE_URL"] ?? "", token: env["STRUT_VOICE_TOKEN"] ?? "" };
  if (!opt && !url) return undefined;
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    /* refused below */
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error("voice.url (STRUT_VOICE_URL) must be an http(s) URL");
  if (!token) throw new Error("voice.url (STRUT_VOICE_URL) is set without voice.token (STRUT_VOICE_TOKEN), the secret strut and the voice service share");
  return { url: url.replace(/\/+$/, ""), token };
}

export function voiceRoutes(app: Hono, deps: { voice?: VoiceConfig; resolveActor: (c: Context) => string | undefined | Promise<string | undefined> }): void {
  const tooBig = bodyLimit({ maxSize: VOICE_BODY_MAX, onError: (c) => c.json({ error: `a call's body is at most ${VOICE_BODY_MAX} bytes` }, 413) });
  app.post(VOICE_CALLS, tooBig, async (c) => {
    // The gate lets a person's token through and refuses a plain peer; the
    // deployment key must still name the person (x-strut-actor).
    const actor = await deps.resolveActor(c);
    if (!actor) return c.json({ error: "forbidden: a call runs as a person — a person token, or the deployment key with x-strut-actor" }, 403);
    const voice = deps.voice;
    if (!voice) return c.json({ error: "no voice service is configured here (STRUT_VOICE_URL)" }, 503);
    const body = await c.req.arrayBuffer();
    let res: Response;
    let answer: ArrayBuffer;
    try {
      const signal = AbortSignal.timeout(VOICE_TIMEOUT_MS);
      res = await fetch(`${voice.url}/calls`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-strut-actor": actor, authorization: `Bearer ${voice.token}` },
        body,
        signal,
      });
      answer = await res.arrayBuffer();
    } catch {
      return c.json({ error: "the voice service is not answering" }, 503);
    }
    const headers = { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" };
    return new Response(answer.byteLength ? answer : null, { status: res.status, headers });
  });
}

/** What a warm-up transcribes: half a second of silence, 16 kHz mono 16-bit,
 *  the shape the voice service sends. */
export function silentWav(seconds = 0.5, sampleRate = 16000): Uint8Array {
  const data = Math.round(seconds * sampleRate) * 2;
  const wav = new Uint8Array(44 + data);
  const v = new DataView(wav.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, data, true);
  return wav;
}

/** Download and load the speech a call uses, so its first turn does not wait:
 *  the recognizer `/audio/transcribe` picks (the same request the voice
 *  service makes, over silence) and the default Kokoro voice (one word,
 *  drained). Both at once; a download a call starts meanwhile is the same
 *  one. Never rejects: a failure is one line in the log, and the call that
 *  follows tries again. */
export async function warmSpeech(deps: {
  stt: Pick<SttService, "transcribe"> | null;
  tts: Pick<TtsService, "speak"> | null;
  log?: (msg: string) => void;
}): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(`[voice] ${m}`));
  const timed = async (what: string, work: () => Promise<unknown>) => {
    const t0 = Date.now();
    try {
      await work();
      log(`${what} ready for calls in ${Date.now() - t0} ms`);
    } catch (e) {
      log(`${what} did not warm up: ${(e as Error).message}`);
    }
  };
  const { stt, tts } = deps;
  await Promise.all([
    stt && timed("speech recognition", () => stt.transcribe(silentWav())),
    tts &&
      timed("speech", async () => {
        for await (const _ of (await tts.speak("Hello.")).audio);
      }),
  ]);
}
