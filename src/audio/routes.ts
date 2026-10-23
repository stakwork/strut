/**
 * HTTP surface over the STT service (plans/local-desktop-and-stt.md §4.4).
 * The WebSocket lives in ws.ts. Everything here is gated by `requireApiKey`
 * (permissive in dev, like the rest of strut).
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireApiKey } from "../auth.js";
import { FIX_TIMEOUT_MS, within } from "./fixer.js";
import { heardOnly, rewrite, type Lexicon } from "./lingo.js";
import { findModel } from "./models.js";
import { SttUnavailableError, type SttService, type SttStreamOptions } from "./stt.js";

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
        // A cold model starts loading here; until it answers in time, the next ones are fixed without it.
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
