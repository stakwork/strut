// Voice calls (plans/private-voice.md §4.1). `POST /voice/calls` hands a
// person's call to the voice service beside strut (`STRUT_VOICE_URL`,
// `createStrut({ voice })`): the body as it came, the person as
// `x-strut-actor`, the secret the two share as the bearer, and the service's
// answer back as it came. Strut only says who the call is for.
//
// A route, not a workflow: the body and the answer carry the call's key and
// room tokens, and a run records its input and output where every peer scope
// may read them. Nothing here logs or keeps either, and no error echoes them.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

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
