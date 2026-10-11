/**
 * Local MiniLM embeddings (`plans/jarvis-graph-compat.md` §2).
 *
 * jarvis encodes `Data_Bank` with
 * `SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")` — 384
 * dims, mean pooling over the attention mask, L2-normalized, truncated at
 * **256 tokens** (sentence-transformers' `max_seq_length`, not the
 * tokenizer's 512). We run the same graph through transformers.js /
 * onnxruntime (identical on ARM and Intel), driving tokenizer + model
 * directly so the 256 cap is explicit. Parity is proven by
 * `embeddings.test.ts` against a Python-produced golden vector.
 *
 * No Redis queue: vectors are computed in-process before the node write.
 * jarvis's "pending" state is purely `text_embeddings IS NULL`. What that
 * leaves behind — a crash between MERGE and vector write, and every node
 * some OTHER writer put in the graph with no vector at all — is the
 * `EmbeddingPass`'s job (below; plans/semantic-search.md).
 */
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { modelDirFromEnv } from "../model-dir.js";
import { int, type Bolt } from "./bolt.js";
import { buildSearchText, renderVectorField, type Embedder } from "./node-writer.js";
import type { SchemaResolver } from "./schema-resolver.js";
import { schemaStatement } from "./schema-seed.js";
import { STRUT_SCHEMAS, THING_TYPE, embeddingColumn } from "./strut-schemas.js";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;
export const EMBEDDING_MAX_TOKENS = 256;

export interface MiniLMOptions {
  /** HF repo id of an ONNX export of all-MiniLM-L6-v2. */
  model?: string;
  /** Where model files are cached. See src/model-dir.ts for the default
   *  (`STRUT_MODEL_DIR`, `STRUT_MODEL_CACHE`, or `<cache root>/strut/models`). */
  cacheDir?: string;
  /** Texts per forward pass. */
  batchSize?: number;
}

type Transformers = typeof import("@huggingface/transformers");

export class MiniLMEmbedder implements Embedder {
  private constructor(
    private readonly tf: Transformers,
    private readonly tokenizer: import("@huggingface/transformers").PreTrainedTokenizer,
    private readonly model: import("@huggingface/transformers").PreTrainedModel,
    private readonly cls: number,
    private readonly sep: number,
    private readonly pad: number,
    private readonly batchSize: number,
  ) {}

  /** Load (downloading on first use) and self-check the output dimension. */
  static async load(opts: MiniLMOptions = {}): Promise<MiniLMEmbedder> {
    let tf: Transformers;
    try {
      tf = await import("@huggingface/transformers");
    } catch (e) {
      // The desktop package (scripts/package-desktop.mjs) omits the
      // embeddings stack: MiniLM only serves graph search, which needs a
      // Neo4j the desktop build doesn't ship. Say so instead of ENOENT.
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "embeddings are not available in this strut build (@huggingface/transformers is not installed); " +
            "graph search needs a server build or `package:desktop --embeddings`",
        );
      }
      throw e;
    }
    tf.env.cacheDir = opts.cacheDir ?? modelDirFromEnv();
    tf.env.allowLocalModels = false;
    const model = opts.model ?? EMBEDDING_MODEL;
    const [tokenizer, net] = await Promise.all([
      tf.AutoTokenizer.from_pretrained(model),
      // fp32 explicitly: quantized weights would drift from jarvis's encoder.
      // Two intra-op threads, not onnxruntime's default of every core: the
      // pass runs hours of inference in the serving process (in a worker
      // thread, `WorkerEmbedder`), beside chat turns and runs; the search
      // path embeds one query at a time and does not notice.
      tf.AutoModel.from_pretrained(model, { dtype: "fp32", session_options: { intraOpNumThreads: 2 } }),
    ]);
    // Special-token ids via the public API: an empty input encodes to
    // exactly [CLS, SEP].
    const specials = tokenizer.encode("", { add_special_tokens: true });
    if (specials.length !== 2) throw new Error(`unexpected special-token layout: ${specials.join(",")}`);
    const e = new MiniLMEmbedder(tf, tokenizer, net, specials[0]!, specials[1]!, tokenizer.pad_token_id ?? 0, opts.batchSize ?? 32);
    const probe = await e.embed(["dimension probe"]);
    if (probe[0]!.length !== EMBEDDING_DIM) {
      throw new Error(`embedding model produced ${probe[0]!.length} dims, expected ${EMBEDDING_DIM}`);
    }
    return e;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.forward(texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  /**
   * Tokenize like sentence-transformers: the 256 cap INCLUDES [CLS]/[SEP],
   * so the body is cut to 254 and the specials are always present.
   * (transformers.js's own `truncation: true` truncates after adding
   * specials and chops [SEP] off long inputs — measurably different
   * vectors.) Right-padded with the pad id; mask 1 on real tokens.
   */
  private encodeBatch(texts: string[]) {
    const seqs = texts.map((t) => {
      const body = this.tokenizer.encode(t, { add_special_tokens: false }).slice(0, EMBEDDING_MAX_TOKENS - 2);
      return [this.cls, ...body, this.sep];
    });
    const batch = seqs.length;
    const seq = Math.max(...seqs.map((s) => s.length));
    const ids = new BigInt64Array(batch * seq).fill(BigInt(this.pad));
    const mask = new BigInt64Array(batch * seq);
    const types = new BigInt64Array(batch * seq);
    seqs.forEach((s, b) => {
      s.forEach((id, i) => {
        ids[b * seq + i] = BigInt(id);
        mask[b * seq + i] = 1n;
      });
    });
    const { Tensor } = this.tf;
    return {
      input_ids: new Tensor("int64", ids, [batch, seq]),
      attention_mask: new Tensor("int64", mask, [batch, seq]),
      token_type_ids: new Tensor("int64", types, [batch, seq]),
      maskData: mask,
    };
  }

  private async forward(texts: string[]): Promise<number[][]> {
    const { input_ids, attention_mask, token_type_ids, maskData } = this.encodeBatch(texts);
    const output = await this.model({ input_ids, attention_mask, token_type_ids });
    const hidden = output["last_hidden_state"] as { data: Float32Array; dims: number[] };
    return meanPoolNormalize(hidden.data, hidden.dims, maskData);
  }
}

/** Mean pooling over the attention mask, then L2 normalization — exactly
 *  sentence-transformers' `Pooling(mean)` + `Normalize`. */
export function meanPoolNormalize(
  hidden: Float32Array,
  dims: number[],
  mask: ArrayLike<number | bigint>,
): number[][] {
  const [batch, seq, dim] = dims as [number, number, number];
  const out: number[][] = [];
  for (let b = 0; b < batch; b++) {
    const vec = new Float64Array(dim);
    let count = 0;
    for (let s = 0; s < seq; s++) {
      if (Number(mask[b * seq + s]) === 0) continue;
      count++;
      const base = (b * seq + s) * dim;
      for (let d = 0; d < dim; d++) vec[d]! += hidden[base + d]!;
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) {
      vec[d]! /= Math.max(count, 1e-9);
      norm += vec[d]! * vec[d]!;
    }
    norm = Math.sqrt(norm) || 1;
    out.push(Array.from(vec, (x) => x / norm));
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** `MiniLMEmbedder.load` as a plain export — the factory `WorkerEmbedder`'s
 *  worker calls by default. */
export function loadMiniLM(opts: MiniLMOptions = {}): Promise<MiniLMEmbedder> {
  return MiniLMEmbedder.load(opts);
}

/** What builds the embedder inside the worker: an export of `module` that
 *  takes `options` and resolves to an `Embedder`. */
export interface WorkerEmbedderSpec {
  module: string;
  factory: string;
  options?: unknown;
}

// Beside this file in `src/` (tsx) and in `build/` alike.
const WORKER_ENTRY = new URL(`./embed-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

type WorkerReply = { ready: true } | { id: number; vectors: number[][] } | { id: number; error: string } | { error: string };

/**
 * An `Embedder` in a worker thread — what the pass embeds with (backend.ts).
 * onnxruntime-node runs a model synchronously (its `run()` is the native
 * call inside a `setImmediate`), so on the main thread every forward pass
 * blocks the event loop of the process serving requests: on swarm38, mcp's
 * whole server (2026-10-11, a tick of catch-up took `GET /lab/health` from
 * 0.34 s to 1.74 s and a graph search from 0.6 s to 5.6 s). Here the main
 * thread only posts texts and receives vectors. The worker starts on the
 * first `embed`, and again after it dies (its calls in flight fail); it
 * holds the process open only while it starts or a call is in flight.
 */
export class WorkerEmbedder implements Embedder {
  private worker: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private readonly pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();
  private next = 0;

  constructor(private readonly spec: WorkerEmbedderSpec = { module: import.meta.url, factory: "loadMiniLM" }) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const worker = await this.start();
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, texts });
    });
  }

  /** Stop the worker; calls in flight fail. */
  async close(): Promise<void> {
    const worker = this.worker;
    this.drop(worker, new Error("embedding worker closed"));
    await worker?.terminate();
  }

  private start(): Promise<Worker> {
    return (this.starting ??= new Promise<Worker>((resolve, reject) => {
      const worker = new Worker(WORKER_ENTRY, { workerData: this.spec });
      this.worker = worker;
      const fail = (e: Error) => {
        this.drop(worker, e);
        reject(e);
      };
      worker.on("message", (m: WorkerReply) => {
        if ("ready" in m) {
          worker.unref();
          return resolve(worker);
        }
        if (!("id" in m)) return fail(new Error(`embedding worker: ${m.error}`));
        const call = this.pending.get(m.id);
        if (!call) return;
        this.pending.delete(m.id);
        if (this.pending.size === 0) worker.unref();
        if ("error" in m) call.reject(new Error(`embedding worker: ${m.error}`));
        else call.resolve(m.vectors);
      });
      worker.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
      worker.on("exit", (code) => fail(new Error(`embedding worker exited with code ${code}`)));
    }));
  }

  /** Forget a worker that died or was closed: its calls in flight fail, and
   *  the next `embed` starts another. */
  private drop(worker: Worker | null, e: Error): void {
    if (!worker || worker !== this.worker) return;
    this.worker = null;
    this.starting = null;
    for (const call of this.pending.values()) call.reject(e);
    this.pending.clear();
  }
}


// ── The pass ────────────────────────────────────────────────────────────────
//
// plans/semantic-search.md §1 — the one repair job for everything semantic
// search needs, for every node type the live `:Schema` meta-graph marks for
// search, whoever wrote the node (strut, stakgraph's ingest over bolt,
// jarvis, an import). A node is STALE when its stored `Data_Bank` is not
// the text the writer would compose today from the schema's `index`
// fields, or its vector is missing — one comparison that catches a node
// never embedded, one embedded before its Schema's `index` widened, a
// field filled in or edited since, and a text another writer reset. The
// pass writes what the writer writes and nothing else: `Data_Bank`,
// `text_embeddings`, `_search_fields_used` (jarvis's record, kept for
// parity) and the resolver's domain label. A type marked `embed: false` is
// never embedded, and a vector found on one is removed.
//
// It pages by `node_key` (an index seek per page, never a scan), decides
// in strut, runs inside the serving process on a timer with a per-tick
// budget checked between batches of rows (its inference in a worker
// thread, `WorkerEmbedder`), and nothing waits on it: a sweep walks every
// marked type (the code types first, then the rest, then the no-embed
// removals); between sweeps each tick embeds the NEWCOMERS — nodes stamped
// `date_added_to_graph` past the last tick's high-water mark, so a freshly
// ingested function is searchable by meaning within a minute. The cursor
// is memory-only: a restart begins the sweep again, cheap on a clean graph.

export interface EmbeddingPassOptions {
  /** Nodes per page read (one index seek each). */
  pageSize?: number;
  /** Texts per embedder call and rows per write. */
  batchSize?: number;
  /** How often a tick runs. */
  tickMs?: number;
  /** How long one tick may work before it yields; at least one page runs. */
  tickBudgetMs?: number;
  /** Pause between the end of one sweep and the start of the next. */
  sweepEveryMs?: number;
  /** Start the timer at construction (the default). Tests pass `false` and
   *  drive `tick()` / `sweep()` by hand. */
  autoStart?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export type SkipReason = "no_schema" | "no_index" | "no_embed" | "invalid_label";

export interface TypeCounts {
  /** Nodes the sweep read. */
  seen: number;
  /** Of those, stale: text or vector rewritten. */
  stale: number;
  embedded: number;
  /** Vectors removed (no-embed types). */
  removed: number;
  /** Pages that failed (the type is left for the next sweep). */
  errors: number;
}

/** `GET /graph/embeddings`. */
export interface EmbeddingPassStatus {
  enabled: true;
  sweep: {
    /** Sweeps begun since the process started (the one in flight included). */
    n: number;
    startedAt: number | null;
    finishedAt: number | null;
    phase: "embed" | "remove" | "idle";
    type: string | null;
    cursor: string | null;
  };
  /** The sweep in flight, per type. */
  current: Record<string, TypeCounts>;
  /** The last complete sweep, per type. */
  last: Record<string, TypeCounts>;
  /** Types the sweep does not embed, and why: no Schema node (a label with
   *  `Data_Bank` nodes and no schema), no `index` on its Schema (the
   *  catch-all text is never embedded by the pass), the no-embed mark, or
   *  a type name that is not a label. */
  skipped: Array<{ type: string; reason: SkipReason }>;
  newcomers: { since: number | null; embedded: number };
  lastError: string | null;
  ticks: number;
}

export const PASS_DEFAULTS = {
  pageSize: 1000,
  batchSize: 100,
  tickMs: 60_000,
  tickBudgetMs: 15_000,
  sweepEveryMs: 3_600_000,
} as const;

const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Labels every node carries beside its type, and the meta-graph's own. */
const NON_TYPE_LABELS = new Set(["Node", "Data_Bank", "Schema", "Migration", "About", "Namespace", THING_TYPE]);
const CODE_DOMAIN_LABEL = "Domain_codeartifact";

interface Marked {
  type: string;
  index: string[];
  /** The resolver's domain label, none for a hidden type or domain. */
  label: string | undefined;
  /** `vector_index` properties with their own `{stem}_embeddings`. */
  vectorIndex: string[];
}

interface PageRow {
  eid: string;
  node_key: string;
  text: unknown;
  values: unknown[];
  unembedded: boolean;
  labeled: boolean;
  vvalues: unknown[];
  vnull: boolean[];
}

/**
 * The stale decision for one page row — pure. `values` holds the index
 * fields ALONE, never the node's other properties: the writer's
 * composition falls through to jarvis's catch-all text when none of the
 * index fields is usable, and with nothing else to find it composes
 * nothing, which is what "a node whose index fields are all blank is left
 * alone" rests on. A list-valued field renders as the writer renders it.
 */
export function decideRow(index: string[], row: { text: unknown; values: unknown[]; unembedded: boolean }): { text: string; fields: string[] } | "clean" | "blank" {
  const values: Record<string, unknown> = {};
  index.forEach((f, i) => {
    const v = row.values[i];
    if (v !== null && v !== undefined) values[f] = v;
  });
  const { text, fields } = buildSearchText({ index }, values);
  if (text === null) return "blank";
  if (!row.unembedded && row.text === text) return "clean";
  return { text, fields };
}

const PAGE_COLUMNS = `elementId(n) AS eid, n.node_key AS node_key, n.Data_Bank AS text,
         [f IN $F | n[f]] AS values, n.text_embeddings IS NULL AS unembedded,
         CASE WHEN $L IS NULL THEN true ELSE $L IN labels(n) END AS labeled,
         [p IN $V | n[p]] AS vvalues, [c IN $C | n[c] IS NULL] AS vnull`;

export class EmbeddingPass {
  private readonly pageSize: number;
  private readonly batchSize: number;
  private readonly tickMs: number;
  private readonly tickBudgetMs: number;
  private readonly sweepEveryMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = false;
  private ddlDone = false;

  private sweepN = 0;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private plan: { embed: Marked[]; remove: Marked[] } | null = null;
  /** The last plan's embed list — what the newcomer tick covers. */
  private embedList: Marked[] = [];
  private pos: { phase: "embed" | "remove" | "idle"; i: number; cursor: string } = { phase: "idle", i: 0, cursor: "" };
  private current: Record<string, TypeCounts> = {};
  private last: Record<string, TypeCounts> = {};
  private skipped: Array<{ type: string; reason: SkipReason }> = [];
  private since: number | null = null;
  private newcomersEmbedded = 0;
  private lastError: string | null = null;
  private ticks = 0;

  constructor(
    private readonly bolt: Bolt,
    private readonly embedder: Embedder,
    private readonly resolver: SchemaResolver,
    opts: EmbeddingPassOptions = {},
  ) {
    this.pageSize = opts.pageSize ?? PASS_DEFAULTS.pageSize;
    this.batchSize = opts.batchSize ?? PASS_DEFAULTS.batchSize;
    this.tickMs = opts.tickMs ?? PASS_DEFAULTS.tickMs;
    this.tickBudgetMs = opts.tickBudgetMs ?? PASS_DEFAULTS.tickBudgetMs;
    this.sweepEveryMs = opts.sweepEveryMs ?? PASS_DEFAULTS.sweepEveryMs;
    this.log = opts.log ?? ((line) => console.log(`[graph embeddings] ${line}`));
    this.now = opts.now ?? Date.now;
    if (opts.autoStart !== false) this.start();
  }

  /** Start the timer: a first tick right away, then every `tickMs`. The
   *  timers never hold the process open. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.first = setTimeout(() => void this.tick(), 0);
    this.first.unref?.();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  /** Stop the timer and wait for the tick in flight to end (it yields at
   *  the next page boundary). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
    await this.inflight?.catch(() => undefined);
  }

  status(): EmbeddingPassStatus {
    const copy = (c: Record<string, TypeCounts>) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v }]));
    const list = this.plan ? (this.pos.phase === "embed" ? this.plan.embed : this.plan.remove) : [];
    return {
      enabled: true,
      sweep: {
        n: this.sweepN,
        startedAt: this.startedAt,
        finishedAt: this.finishedAt,
        phase: this.pos.phase,
        type: list[this.pos.i]?.type ?? null,
        cursor: this.plan ? this.pos.cursor : null,
      },
      current: copy(this.current),
      last: copy(this.last),
      skipped: this.skipped.map((s) => ({ ...s })),
      newcomers: { since: this.since, embedded: this.newcomersEmbedded },
      lastError: this.lastError,
      ticks: this.ticks,
    };
  }

  /** One tick: resume the sweep in flight (or begin one when the pause has
   *  passed, else embed the newcomers) for up to the budget. Ticks never
   *  overlap — a call during one joins it. */
  tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run()
      .catch((e) => {
        this.lastError = errorMessage(e);
        this.log(`tick failed: ${this.lastError}`);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Run the sweep in flight — or a new one — to its end. What a caller
   *  that wants the graph repaired NOW uses; the timer never needs it. */
  async sweep(): Promise<void> {
    if (!this.plan) await this.beginSweep();
    while (this.plan && !this.stopped) await this.tick();
  }

  private async run(): Promise<void> {
    this.ticks++;
    const start = this.now();
    const did = { embedded: 0, removed: 0, newcomers: 0, ended: false };
    if (!this.plan && (this.finishedAt === null || this.now() - this.finishedAt >= this.sweepEveryMs)) await this.beginSweep();
    const was = this.plan ? `sweep ${this.sweepN}` : "between sweeps";
    if (this.plan) await this.work(start, did);
    else await this.newcomers(start, did);
    if (did.embedded || did.removed || did.newcomers || did.ended) {
      const at = this.plan ? ` at ${this.pos.phase} ${this.status().sweep.type ?? "-"} ${JSON.stringify(this.pos.cursor)}` : "";
      this.log(`tick ${this.ticks} (${was}${at}): embedded ${did.embedded}, removed ${did.removed}, newcomers ${did.newcomers}${did.ended ? "; sweep done" : ""}`);
    }
  }

  // ── the sweep ─────────────────────────────────────────────────────────

  private async beginSweep(): Promise<void> {
    this.resolver.invalidate();
    const { embed, remove, skipped } = await this.planSweep();
    if (!this.ddlDone) {
      // The cursor seeks on `node_key`; every seeded type has the index
      // (jarvis's `add_node_key_indexes`, strut's two seeds), and this
      // makes it so on any graph. The newcomer tick seeks on the stamp.
      for (const m of [...embed, ...remove]) await schemaStatement(this.bolt, `CREATE INDEX IF NOT EXISTS FOR (n:\`${m.type}\`) ON (n.node_key)`);
      await schemaStatement(this.bolt, `CREATE INDEX IF NOT EXISTS FOR (n:Data_Bank) ON (n.date_added_to_graph)`);
      this.ddlDone = true;
    }
    this.sweepN++;
    this.startedAt = this.now();
    this.finishedAt = null;
    // Everything stamped after this is a newcomer; the sweep covers what
    // exists now (a node written behind the cursor is caught after it).
    if (this.since === null) this.since = this.startedAt;
    this.plan = { embed, remove };
    this.embedList = embed;
    this.skipped = skipped;
    this.current = {};
    this.pos = { phase: embed.length ? "embed" : remove.length ? "remove" : "idle", i: 0, cursor: "" };
    this.log(
      `sweep ${this.sweepN} begins: ${embed.length} type(s) to embed (${embed.map((m) => m.type).join(", ")}), ` +
        `${remove.length} no-embed (${remove.map((m) => m.type).join(", ")}), ${skipped.length} skipped`,
    );
    if (!embed.length && !remove.length) this.endSweep();
  }

  /** Every type with a live Schema, through the resolver: what to embed
   *  (its `index`, its domain label), what to strip, what to leave alone. */
  private async planSweep(): Promise<{ embed: Marked[]; remove: Marked[]; skipped: Array<{ type: string; reason: SkipReason }> }> {
    const types = new Set<string>(STRUT_SCHEMAS.map((s) => s.type));
    const live = await this.bolt.run(
      `MATCH (s:Schema) WHERE s.type IS NOT NULL AND s.type <> '*' AND (s.is_deleted IS NULL OR s.is_deleted = false)
       RETURN DISTINCT s.type AS t`,
    );
    for (const r of live) types.add(String(r["t"]));
    const embed: Marked[] = [];
    const remove: Marked[] = [];
    const skipped: Array<{ type: string; reason: SkipReason }> = [];
    for (const t of [...types].sort()) {
      if (NON_TYPE_LABELS.has(t)) continue;
      if (!LABEL.test(t)) {
        skipped.push({ type: t, reason: "invalid_label" });
        continue;
      }
      const s = await this.resolver.schema(t);
      if (!s) {
        skipped.push({ type: t, reason: "no_schema" });
        continue;
      }
      const m: Marked = { type: s.type, index: s.index, label: s.domainLabels[0], vectorIndex: s.vector_index };
      if (!s.embed) {
        remove.push(m);
        skipped.push({ type: s.type, reason: "no_embed" });
      } else if (s.index.length === 1 && s.index[0] === "node_key") {
        skipped.push({ type: s.type, reason: "no_index" });
      } else embed.push(m);
    }
    // A label with `Data_Bank` nodes and no Schema node (stakgraph's
    // `Context`, `Chunk`): named, never embedded — the status read says so.
    const labels = (await this.bolt.run(`CALL db.labels() YIELD label RETURN label`)).map((r) => String(r["label"]));
    for (const l of labels.sort()) {
      if (types.has(l) || NON_TYPE_LABELS.has(l) || l.startsWith("Domain_") || !LABEL.test(l)) continue;
      const any = await this.bolt.run(`MATCH (n:\`${l}\`:Data_Bank) RETURN true AS x LIMIT 1`);
      if (any.length) skipped.push({ type: l, reason: "no_schema" });
    }
    const code = (m: Marked) => (m.label === CODE_DOMAIN_LABEL ? 0 : 1);
    embed.sort((a, b) => code(a) - code(b) || a.type.localeCompare(b.type));
    return { embed, remove, skipped };
  }

  private endSweep(): void {
    this.last = this.current;
    this.current = {};
    this.finishedAt = this.now();
    this.plan = null;
    this.pos = { phase: "idle", i: 0, cursor: "" };
    const total = (k: keyof TypeCounts) => Object.values(this.last).reduce((s, c) => s + c[k], 0);
    this.log(
      `sweep ${this.sweepN} done in ${this.finishedAt - (this.startedAt ?? this.finishedAt)} ms: ` +
        `seen ${total("seen")}, stale ${total("stale")}, embedded ${total("embedded")}, removed ${total("removed")}, errors ${total("errors")}`,
    );
  }

  /** Pages until the budget is spent or the sweep ends. */
  private async work(start: number, did: { embedded: number; removed: number; ended: boolean }): Promise<void> {
    const spent = () => this.now() - start >= this.tickBudgetMs;
    let pages = 0;
    while (this.plan && !this.stopped) {
      if (pages > 0 && spent()) return;
      const list = this.pos.phase === "embed" ? this.plan.embed : this.plan.remove;
      const m = list[this.pos.i];
      if (!m) {
        if (this.pos.phase === "embed" && this.plan.remove.length) this.pos = { phase: "remove", i: 0, cursor: "" };
        else {
          this.endSweep();
          did.ended = true;
        }
        continue;
      }
      try {
        const exhausted = this.pos.phase === "embed" ? await this.embedPage(m, did, spent) : await this.removePage(m, did);
        if (exhausted) this.pos = { ...this.pos, i: this.pos.i + 1, cursor: "" };
      } catch (e) {
        // On to the next type; the next sweep retries this one.
        this.counts(m.type).errors++;
        this.lastError = `${m.type}: ${errorMessage(e)}`;
        this.log(`page failed, ${this.lastError}`);
        this.pos = { ...this.pos, i: this.pos.i + 1, cursor: "" };
      }
      pages++;
    }
  }

  private counts(type: string): TypeCounts {
    return (this.current[type] ??= { seen: 0, stale: 0, embedded: 0, removed: 0, errors: 0 });
  }

  /** One page of a marked type from the cursor, repaired a batch of rows at
   *  a time: a batch is finished (text, vector, per-field vectors, label)
   *  and the cursor moved past it before the next begins, so a tick that has
   *  spent its budget stops between batches — a page of 1,000 long texts is
   *  half a minute of inference on a swarm's CPU. True when the type is done. */
  private async embedPage(m: Marked, did: { embedded: number }, spent: () => boolean): Promise<boolean> {
    const rows = (await this.bolt.run(
      `MATCH (n:\`${m.type}\`) WHERE n.node_key > $cursor
       WITH n ORDER BY n.node_key LIMIT $page
       RETURN ${PAGE_COLUMNS}`,
      this.pageParams(m, { cursor: this.pos.cursor }),
    )) as unknown as PageRow[];
    if (rows.length === 0) return true;
    const counts = this.counts(m.type);
    for (let i = 0; i < rows.length; i += this.batchSize) {
      if (i > 0 && spent()) return false;
      const batch = rows.slice(i, i + this.batchSize);
      counts.seen += batch.length;
      did.embedded += await this.repair(m, batch, counts);
      this.pos = { ...this.pos, cursor: batch[batch.length - 1]!.node_key };
    }
    return rows.length < this.pageSize;
  }

  private pageParams(m: Marked, extra: Record<string, unknown>): Record<string, unknown> {
    return { ...extra, page: int(this.pageSize), F: m.index, V: m.vectorIndex, C: m.vectorIndex.map(embeddingColumn), L: m.label ?? null };
  }

  /** Rewrite the stale rows of a page (text, record, vector, per-field
   *  vectors), label the unlabeled ones. Returns how many were embedded. */
  private async repair(m: Marked, rows: PageRow[], counts: TypeCounts): Promise<number> {
    const stale: Array<{ eid: string; text: string; fields: string[] }> = [];
    const unlabeled: string[] = [];
    const fieldJobs = new Map<string, Array<{ eid: string; text: string }>>();
    for (const r of rows) {
      const d = decideRow(m.index, r);
      if (d === "blank") continue;
      if (d !== "clean") stale.push({ eid: r.eid, ...d });
      if (!r.labeled) unlabeled.push(r.eid);
      m.vectorIndex.forEach((p, i) => {
        const v = r.vvalues[i];
        if (!r.vnull[i] || v === null || v === undefined) return;
        const rendered = renderVectorField(p, String(v));
        if (rendered) (fieldJobs.get(embeddingColumn(p)) ?? fieldJobs.set(embeddingColumn(p), []).get(embeddingColumn(p))!).push({ eid: r.eid, text: rendered });
      });
    }
    counts.stale += stale.length;
    let embedded = 0;
    for (let i = 0; i < stale.length; i += this.batchSize) {
      const batch = stale.slice(i, i + this.batchSize);
      const vectors = await this.embedder.embed(batch.map((b) => b.text));
      await this.bolt.run(
        `UNWIND $rows AS row
         MATCH (n) WHERE elementId(n) = row.eid
         SET n.Data_Bank = row.text, n._search_fields_used = row.fields, n.text_embeddings = row.vector`,
        { rows: batch.map((b, j) => ({ eid: b.eid, text: b.text, fields: b.fields, vector: vectors[j] })) },
      );
      counts.embedded += batch.length;
      embedded += batch.length;
    }
    for (const [column, jobs] of fieldJobs) {
      for (let i = 0; i < jobs.length; i += this.batchSize) {
        const batch = jobs.slice(i, i + this.batchSize);
        const vectors = await this.embedder.embed(batch.map((b) => b.text));
        await this.bolt.run(
          `UNWIND $rows AS row MATCH (n) WHERE elementId(n) = row.eid SET n.\`${column}\` = row.vector`,
          { rows: batch.map((b, j) => ({ eid: b.eid, vector: vectors[j] })) },
        );
      }
    }
    if (m.label && unlabeled.length) {
      await this.bolt.run(`UNWIND $eids AS eid MATCH (n) WHERE elementId(n) = eid SET n:\`${m.label}\``, { eids: unlabeled });
    }
    return embedded;
  }

  /** One page of a no-embed type: strip the vectors it holds. */
  private async removePage(m: Marked, did: { removed: number }): Promise<boolean> {
    const rows = await this.bolt.run(
      `MATCH (n:\`${m.type}\`) WHERE n.node_key > $cursor
       WITH n ORDER BY n.node_key LIMIT $page
       RETURN elementId(n) AS eid, n.node_key AS node_key, n.text_embeddings IS NOT NULL AS embedded`,
      { cursor: this.pos.cursor, page: int(this.pageSize) },
    );
    if (rows.length === 0) return true;
    const counts = this.counts(m.type);
    counts.seen += rows.length;
    const eids = rows.filter((r) => r["embedded"] === true).map((r) => String(r["eid"]));
    for (let i = 0; i < eids.length; i += this.batchSize) {
      const batch = eids.slice(i, i + this.batchSize);
      await this.bolt.run(`UNWIND $eids AS eid MATCH (n) WHERE elementId(n) = eid REMOVE n.text_embeddings`, { eids: batch });
      counts.removed += batch.length;
      did.removed += batch.length;
    }
    this.pos = { ...this.pos, cursor: String(rows[rows.length - 1]!["node_key"]) };
    return rows.length < this.pageSize;
  }

  // ── between sweeps ────────────────────────────────────────────────────

  /** Embed what was stamped since the last tick and carries a marked label
   *  and no vector — a range seek on `date_added_to_graph` from a cursor,
   *  the index fields of every marked type read at once. Marked labels
   *  only: rows the pass never embeds (a run's `StrutToolCall`s, agent-log
   *  `Turn`s) would fill a page and hide the code ingested beside them. The
   *  cursor is `>=` because stakgraph stamps a whole ingest batch with one
   *  `$now`: a row embedded here leaves `text_embeddings IS NULL`, so a
   *  stamp is read again at most once, and a full page of blank rows on one
   *  stamp steps past it. Batches as in `embedPage`, so a spent budget stops
   *  the tick between them and the next resumes at the last batch's stamp.
   *  A node that gets no vector here (blank) waits for the next sweep. */
  private async newcomers(start: number, did: { newcomers: number }): Promise<void> {
    if (this.since === null || this.embedList.length === 0) return;
    const until = this.now();
    const byLabel = new Map(this.embedList.map((m) => [m.type, m]));
    const fields = [...new Set(this.embedList.flatMap((m) => m.index))];
    const scratch: TypeCounts = { seen: 0, stale: 0, embedded: 0, removed: 0, errors: 0 }; // `current` is the sweep's
    const spent = () => this.now() - start >= this.tickBudgetMs;
    let after = this.since;
    for (let pages = 0; ; pages++) {
      if (pages > 0 && spent()) {
        this.since = after;
        return;
      }
      const rows = await this.bolt.run(
        `MATCH (n:Data_Bank) WHERE n.date_added_to_graph >= $after AND n.text_embeddings IS NULL
           AND any(l IN labels(n) WHERE l IN $types)
         WITH n ORDER BY n.date_added_to_graph LIMIT $page
         RETURN elementId(n) AS eid, labels(n) AS labels, n.date_added_to_graph AS at, n.Data_Bank AS text, [f IN $F | n[f]] AS values`,
        { after: int(after), types: [...byLabel.keys()], page: int(this.pageSize), F: fields },
      );
      const from = after;
      let embedded = 0;
      for (let i = 0; i < rows.length; i += this.batchSize) {
        if (i > 0 && spent()) {
          this.since = after;
          return;
        }
        const batch = rows.slice(i, i + this.batchSize);
        const byType = new Map<Marked, PageRow[]>();
        for (const r of batch) {
          const labels = r["labels"] as string[];
          const m = labels.map((l) => byLabel.get(l)).find((x): x is Marked => !!x);
          if (!m) continue;
          const all = r["values"] as unknown[];
          const row: PageRow = {
            eid: String(r["eid"]),
            node_key: "",
            text: r["text"],
            values: m.index.map((f) => all[fields.indexOf(f)]),
            unembedded: true,
            labeled: !m.label || labels.includes(m.label),
            vvalues: [],
            vnull: [],
          };
          byType.set(m, [...(byType.get(m) ?? []), row]);
        }
        let n = 0;
        for (const [m, typed] of byType) n += await this.repair({ ...m, vectorIndex: [] }, typed, scratch);
        embedded += n;
        this.newcomersEmbedded += n;
        did.newcomers += n;
        after = Number(batch[batch.length - 1]!["at"]);
      }
      if (rows.length < this.pageSize) break;
      if (embedded === 0 && after === from) after += 1;
    }
    this.since = until;
  }
}

function errorMessage(e: unknown): string {
  return ((e as Error)?.message ?? String(e)).split("\n")[0]!;
}
