/**
 * HTTP surface over the STT service (plans/local-desktop-and-stt.md §4.4)
 * and, in `speakRoutes`, the TTS service (plans/private-voice.md §3.3).
 * The WebSocket lives in ws.ts. Everything here is gated by `requireApiKey`
 * (permissive in dev, like the rest of strut).
 */
import type { Context, Hono } from "hono";
import { stream, streamSSE } from "hono/streaming";
import { requireApiKey } from "../auth.js";
import { FIX_TIMEOUT_MS, within } from "./fixer.js";
import { heardOnly, rewrite, type Lexicon } from "./lingo.js";
import { findModel } from "./models.js";
import { SttUnavailableError, type SttService, type SttStreamOptions } from "./stt.js";
import { SpeakRequestError, TtsUnavailableError, type Speech, type TtsService } from "./tts.js";

export interface AudioRoutesOptions {
  /** Dictation's vocabulary (memory/lexicon), read per transcription; absent or failing: no rewrite. */
  lexicon?: () => Promise<Lexicon>;
}

/** The longest a rewrite that missed its time keeps the fixer out of the next transcripts. */
const LATE_MS = 30_000;

export function audioRoutes(app: Hono, stt: SttService, opts: AudioRoutesOptions = {}): void {
  const unread = new Set<string>();
  // A rewrite that missed FIX_TIMEOUT_MS keeps running in the fixer's worker
  // (a cold model loading, a long transcript). Until it is done (or LATE_MS
  // has passed, for one that never answers) the next transcripts go without
  // the fixer, so a slow model never piles up calls.
  let late: unknown = null;
  app.use("/audio/*", requireApiKey);

  app.get("/audio/models", async (c) => {
    return c.json({ available: await stt.available(), modelDir: stt.modelDir, models: await stt.models() });
  });

  // SSE: {"phase":"download","received","total"} … {"phase":"extract"} … {"phase":"done"}
  app.post("/audio/models/:id/download", async (c) => {
    const id = c.req.param("id");
    if (!findModel(id)) return c.json({ error: `unknown model ${JSON.stringify(id)}` }, 404);
    if (!(await stt.available())) return c.json({ error: new SttUnavailableError().message }, 501);
    return streamSSE(c, async (s) => {
      let last = 0;
      try {
        await stt.ensureModel(id, (p) => {
          // Throttle byte progress to ~every 1 MB so the stream stays light.
          if (p.phase === "download" && p.received - last < 1_000_000 && p.received !== p.total) return;
          if (p.phase === "download") last = p.received;
          void s.writeSSE({ event: "progress", data: JSON.stringify(p) });
        });
        await s.writeSSE({ event: "progress", data: JSON.stringify({ phase: "done" }) });
      } catch (e) {
        await s.writeSSE({ event: "error", data: JSON.stringify({ error: (e as Error).message }) });
      }
    });
  });

  // Raw audio/wav body. Query: model, partialModel (ignored: batch is
  // single-recognizer), hotwords (list name), hotwordsScore, session, lingo
  // (0: the transcript as heard, no vocabulary). `text` is what to type: the
  // transcript with the user's vocabulary applied (src/audio/lingo.ts) by the
  // picked fixer, named in `fixer`; with none, or when it takes longer than
  // FIX_TIMEOUT_MS, fillers and doubled words by rule and only exact learned
  // mishearings of two or more words (`fixer: null`). When that
  // changed it, `heard` (the transcript) and `changes`. `segments` stay as heard.
  app.post("/audio/transcribe", async (c) => {
    const q = c.req.query();
    const o: Omit<SttStreamOptions, "sampleRate"> = {};
    if (q["model"]) o.model = q["model"];
    if (q["hotwords"]) o.hotwords = q["hotwords"];
    if (q["hotwordsScore"]) o.hotwordsScore = Number(q["hotwordsScore"]);
    if (q["session"]) o.session = q["session"];
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength < 44) return c.json({ error: "expected a WAV body" }, 400);
    let result;
    try {
      result = await stt.transcribe(body, o);
    } catch (e) {
      return errorResponse(c, e);
    }
    const asHeard = { ...result, fixer: null };
    if (q["lingo"] === "0" || !opts.lexicon || !result.text) return c.json(asHeard);
    // Never the transcript in a log: only why the vocabulary was not read, once.
    const lexicon = await opts.lexicon().catch((e: unknown) => {
      const why = (e as Error).message;
      if (!unread.has(why)) console.warn(`[audio] dictation vocabulary not read, transcripts go out as heard: ${why}`);
      unread.add(why);
      return undefined;
    });
    if (!lexicon) return c.json(asHeard);
    let out: { text: string; changes: unknown[] } | undefined;
    let fixer: string | null = null;
    try {
      const f = late ? null : await stt.fixer?.current();
      if (f) {
        // `listen()` starts the model loading (`warm`); one still cold answers late, and the next ones are fixed without it.
        const p = rewrite(result.text, lexicon, f);
        out = await within(p, FIX_TIMEOUT_MS);
        if (out) fixer = f.id;
        else {
          const mine = (late = {});
          const done = () => void (late === mine && (late = null));
          setTimeout(done, LATE_MS).unref();
          p.then(done, done);
        }
      }
    } catch (e) {
      // A transcript is never lost to the fixer: it goes out with the learned mishearings only.
      console.error(`[audio] dictation fixer failed: ${(e as Error).message}`);
    }
    try {
      out ??= heardOnly(result.text, lexicon);
    } catch (e) {
      console.error(`[audio] dictation rewrite failed: ${(e as Error).message}`);
    }
    if (!out || out.text === result.text) return c.json({ ...result, fixer });
    return c.json({ ...result, text: out.text, heard: result.text, changes: out.changes, fixer });
  });

  // ── Hotword lists (the dream cycle's promotion artifact) ────────────────

  app.get("/audio/hotwords", async (c) => c.json({ lists: await stt.hotwords.list() }));

  app.get("/audio/hotwords/:name", async (c) => {
    const text = await stt.hotwords.get(c.req.param("name"));
    if (text == null) return c.json({ error: "not found" }, 404);
    return c.text(text);
  });

  // Body: text/plain (one phrase per line, optional ` :score`) or JSON
  // { "phrases": ["…", …] } / { "text": "…" }.
  app.put("/audio/hotwords/:name", async (c) => {
    const name = c.req.param("name");
    let text: string;
    if ((c.req.header("content-type") ?? "").includes("application/json")) {
      const body = (await c.req.json()) as { phrases?: string[]; text?: string };
      text = body.text ?? (body.phrases ?? []).join("\n");
    } else {
      text = await c.req.text();
    }
    try {
      const list = await stt.hotwords.put(name, text);
      return c.json({ name, count: list.length });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete("/audio/hotwords/:name", async (c) => {
    const ok = await stt.hotwords.delete(c.req.param("name"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // ── Sessions (finals + corrections) ─────────────────────────────────────

  app.get("/audio/sessions", async (c) => c.json({ sessions: await stt.sessions.list() }));

  app.get("/audio/sessions/:id", async (c) => {
    const entries = await stt.sessions.get(c.req.param("id"));
    if (!entries) return c.json({ error: "not found" }, 404);
    return c.json({ id: c.req.param("id"), entries });
  });

  app.post("/audio/sessions/:id/corrections", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { index?: number; text?: string } | null;
    if (!body || typeof body.index !== "number" || typeof body.text !== "string") {
      return c.json({ error: "expected { index: number, text: string }" }, 400);
    }
    await stt.correct(c.req.param("id"), body.index, body.text);
    return c.json({ ok: true });
  });
}

function errorResponse(c: { json: (b: unknown, s: 400 | 501) => Response }, e: unknown): Response {
  if (e instanceof SttUnavailableError) return c.json({ error: e.message }, 501);
  return c.json({ error: (e as Error).message }, 400);
}

// ── Speech (text-to-speech) ───────────────────────────────────────────────

export function speakRoutes(app: Hono, tts: TtsService): void {
  app.use("/audio/speak", requireApiKey);

  // The models and their voices, with whether each is on disk.
  app.get("/audio/speak", async (c) => {
    return c.json({ available: await tts.available(), modelDir: tts.modelDir, models: await tts.models() });
  });

  // Body { text, voice?, speed?, model? } → mono 16-bit little-endian PCM at
  // `x-sample-rate`, written a sentence at a time as Kokoro finishes each. A
  // model not on disk is downloaded first. An error before the first
  // sentence is JSON with a status; after it, the body just ends (logged).
  // A client that hangs up stops the generation, not only the sending.
  app.post("/audio/speak", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const { text, voice, speed, model } = body ?? {};
    if (
      typeof text !== "string" ||
      (voice !== undefined && typeof voice !== "string") ||
      (speed !== undefined && typeof speed !== "number") ||
      (model !== undefined && typeof model !== "string")
    ) {
      return c.json({ error: "expected { text: string, voice?: string, speed?: number, model?: string }" }, 400);
    }
    // Stopped by a hang-up before the first sentence (the request's signal)
    // or after it (the stream's abort, below).
    const stop = new AbortController();
    let speech: Speech;
    let pieces: AsyncIterator<Uint8Array>;
    let first: IteratorResult<Uint8Array>;
    try {
      speech = await tts.speak(text, { voice, speed, model, signal: AbortSignal.any([stop.signal, c.req.raw.signal]) });
      pieces = speech.audio[Symbol.asyncIterator]();
      first = await pieces.next();
    } catch (e) {
      stop.abort();
      return speakError(c, e);
    }
    c.header("content-type", "audio/pcm");
    c.header("x-sample-rate", String(speech.sampleRate));
    c.header("x-voice", speech.voice);
    c.header("cache-control", "no-store");
    return stream(
      c,
      async (s) => {
        s.onAbort(() => stop.abort());
        try {
          for (let r = first; !r.done && !s.aborted; r = await pieces.next()) await s.write(r.value);
        } finally {
          await pieces.return?.();
        }
      },
      async (e) => console.error(`[audio] speech cut off: ${e.message}`),
    );
  });
}

function speakError(c: Context, e: unknown): Response {
  if (e instanceof SpeakRequestError) return c.json({ error: e.message }, 400);
  if (e instanceof TtsUnavailableError) return c.json({ error: e.message }, 501);
  return c.json({ error: (e as Error).message }, 500);
}
