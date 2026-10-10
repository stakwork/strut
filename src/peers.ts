/**
 * Peers — the OTHER struts this one may call (plans/federation.md §2.2, §3).
 *
 * A strut knows nothing about other struts, not even its own name. A peer
 * is a record `{ id, baseUrl, token, label? }` someone put here: a host
 * pushes it (`PUT /peers/:id`, the way hive pushes delegations and actor
 * secrets), or a person pastes it on a strut the host cannot reach — a
 * desktop strut behind NAT (`STRUT_PEERS`). The id is the caller's name for
 * the peer — hive uses the workspace slug, what a person types as `@slug`.
 *
 * The records live in a FOURTH encrypted `FileSecretStore` file,
 * `peers.json`, beside `secrets.json`, `mothership.json` and
 * `actor-secrets.json` — one entry per peer, `P_<hex(id)>` → the record as
 * JSON — never in `GET /secrets` or the builder's `list_secrets`. What a
 * step gets is `ctx.services.peers`, a capability that NAMES a peer and
 * makes a request with its token injected: the token itself is readable by
 * nothing (`list` returns ids, labels and base URLs). What a step can do
 * through it is bounded by the token's scope on the peer — today a swarm's
 * key, which is why the plan's `lab:peer` scope matters.
 *
 * The client below is what `strut/run-workflow` and the builder's
 * `peer`-taking tools share: launch a run on the peer (`POST …/run`, the
 * caller's principal forwarded as `x-strut-actor` — billed and secret-bound
 * on the peer, for that person), then wait on the peer's SSE tail. The tail
 * is READER-initiated — the caller needs to reach the peer and nothing
 * else, which is what lets a strut behind NAT call a cloud one — so a
 * dropped connection is reattached with `?skip=N`, N the events read so
 * far (`TailOpts.skip`, the join the web UI already makes), and every event
 * reaches the caller once. Nothing of a run's secrets or files crosses: a
 * run executes, reads secrets and keeps its artifacts where the workflow
 * lives.
 */

import { coerceJsonArg, type RunEvent, type RunResult } from "./core.js";
import type { SecretStore } from "./secret-store.js";

/** The peers file, beside `secrets.json` under `dataDir`. */
export const PEERS_FILE = "peers.json";

export interface Peer {
  /** The caller's name for the peer: `[A-Za-z0-9][A-Za-z0-9._-]*`, ≤ 64. */
  id: string;
  /** The peer strut's base URL (`https://swarm.example:3355/lab`), no trailing slash. */
  baseUrl: string;
  /** The bearer the peer accepts — its `STRUT_API_KEY`, or a scoped token. */
  token: string;
  label?: string;
}

/** A peer as anything may see it: never the token. */
export interface PeerInfo {
  id: string;
  baseUrl: string;
  label?: string;
}

export interface PeerStore {
  get(id: string): Promise<Peer | undefined>;
  set(peer: Peer): Promise<void>;
  /** Returns true if it existed. */
  delete(id: string): Promise<boolean>;
  /** Every peer, sorted by id — ids, labels and base URLs, never tokens. */
  list(): Promise<PeerInfo[]>;
}

// ── the record ────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Why an id is not a peer id, or null when it is. */
export function peerIdProblem(id: unknown): string | null {
  if (typeof id !== "string" || !id) return "is empty";
  if (!ID_RE.test(id)) return `"${id}" is not a peer id (letters, digits, ". _ -" inside, a letter or digit first, at most 64)`;
  return null;
}

/** An http(s) URL with trailing slashes removed; throws otherwise. */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !/^https?:\/\/\S+$/.test(raw.trim())) {
    throw new Error("baseUrl must be an http(s) URL");
  }
  return raw.trim().replace(/\/+$/, "");
}

/** Validate a record as it arrives (a PUT body, an env entry). */
export function checkPeer(raw: unknown): Peer {
  const p = (raw ?? {}) as Record<string, unknown>;
  const idProblem = peerIdProblem(p["id"]);
  if (idProblem) throw new Error(`peer id ${idProblem}`);
  const baseUrl = normalizeBaseUrl(p["baseUrl"]);
  if (typeof p["token"] !== "string" || !p["token"]) throw new Error("token (non-empty string) is required");
  if (p["label"] !== undefined && typeof p["label"] !== "string") throw new Error("label must be a string");
  return {
    id: p["id"] as string,
    baseUrl,
    token: p["token"],
    ...(p["label"] ? { label: p["label"] } : {}),
  };
}

/** `STRUT_PEERS`: a JSON array of records, for a strut nobody pushes to. */
export function parsePeersEnv(raw: string | undefined): Peer[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`STRUT_PEERS is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("STRUT_PEERS must be a JSON array of { id, baseUrl, token, label? }");
  return parsed.map((entry, i) => {
    try {
      return checkPeer(entry);
    } catch (err) {
      throw new Error(`STRUT_PEERS[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

const PREFIX = "P_";
const keyFor = (id: string): string => `${PREFIX}${Buffer.from(id, "utf8").toString("hex")}`;
const idOf = (key: string): string => Buffer.from(key.slice(PREFIX.length), "hex").toString("utf8");

/** A peer store over any `SecretStore` (one encrypted file, or memory). */
export function peerStore(secrets: SecretStore): PeerStore {
  const read = async (id: string): Promise<Peer | undefined> => {
    const raw = await secrets.get(keyFor(id));
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Omit<Peer, "id">;
    return { id, ...v };
  };
  return {
    get: read,
    async set(peer) {
      const checked = checkPeer(peer);
      const { id, ...rest } = checked;
      await secrets.set(keyFor(id), JSON.stringify(rest));
    },
    async delete(id) {
      if (peerIdProblem(id)) return false;
      return secrets.delete(keyFor(id));
    },
    async list() {
      const names = (await secrets.list()).map((s) => s.name).filter((n) => n.startsWith(PREFIX));
      const peers = await Promise.all(names.map((n) => read(idOf(n))));
      return peers
        .filter((p): p is Peer => p !== undefined)
        .map(({ id, baseUrl, label }) => ({ id, baseUrl, ...(label ? { label } : {}) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

// ── the capability ────────────────────────────────────────────────────────

export interface PeerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type PeerFetch = (url: string, init?: PeerFetchInit) => Promise<Response>;

/** `ctx.services.peers`: name a peer, make a request; the token stays inside. */
export interface PeersCapability {
  list(): Promise<PeerInfo[]>;
  /** `path` is relative to the peer's base URL (`/workflows/x/run`). Throws
   *  `peer_unknown:` for an id not on file. The response is the peer's,
   *  unread — a stream for the SSE tail, JSON for the rest. */
  fetch(id: string, path: string, init?: PeerFetchInit): Promise<Response>;
}

export function peersCapability(store: PeerStore, fetchImpl: PeerFetch = (u, i) => fetch(u, i)): PeersCapability {
  return {
    list: () => store.list(),
    async fetch(id, path, init) {
      const peer = await store.get(id);
      if (!peer) throw new Error(`peer_unknown: no peer "${id}" — GET /peers lists the struts this one can call`);
      return fetchImpl(`${peer.baseUrl}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${peer.token}` },
      });
    },
  };
}

// ── the client: launch, tail, cancel ──────────────────────────────────────

export interface PeerRunHandle {
  peer: string;
  workflow: string;
  runId: string;
}

export interface PeerLaunch {
  peer: string;
  workflow: string;
  version?: string;
  input?: unknown;
  params?: Record<string, unknown>;
  /** The job on the PEER to launch under — the caller names it; never the
   *  caller's own job (no shared directory across struts, §2.2). */
  job?: string;
  /** Forwarded as `x-strut-actor`: who the peer bills and binds secrets to. */
  actor?: string;
}

/** What a peer's run came back as — the step's output shape. */
export interface PeerRunResult extends PeerRunHandle {
  status: RunResult["status"] | "running";
  output?: unknown;
  error?: { message: string };
  durationMs?: number;
}

const runPath = (h: { workflow: string; runId: string }): string =>
  `/workflows/${encodeURIComponent(h.workflow)}/runs/${encodeURIComponent(h.runId)}`;

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === "string") return j.error;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 500);
}

/** `POST {peer}/workflows/:name[/:version]/run` → the handle. A refusal
 *  (4xx/5xx) throws with the peer's message, so `job_busy:` reads the same
 *  here as there. */
export async function launchOnPeer(peers: PeersCapability, launch: PeerLaunch): Promise<PeerRunHandle> {
  const path =
    `/workflows/${encodeURIComponent(launch.workflow)}` +
    (launch.version ? `/${encodeURIComponent(launch.version)}` : "") +
    "/run";
  const res = await peers.fetch(launch.peer, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(launch.actor ? { "x-strut-actor": launch.actor } : {}),
    },
    body: JSON.stringify({
      // A model calling strut/run-workflow as a tool may hand the input as a
      // JSON string; the peer's input schema would refuse it.
      input: coerceJsonArg(launch.input) ?? {},
      ...(launch.params ? { params: coerceJsonArg(launch.params) } : {}),
      ...(launch.job ? { job: launch.job } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`peer "${launch.peer}" refused POST ${path} (${res.status}): ${await errorText(res)}`);
  }
  const body = (await res.json()) as { runId?: unknown };
  if (typeof body.runId !== "string" || !body.runId) {
    throw new Error(`peer "${launch.peer}" answered POST ${path} without a runId`);
  }
  return { peer: launch.peer, workflow: launch.workflow, runId: body.runId };
}

/** `POST …/cancel` on the peer. Best effort: false when it could not be
 *  delivered (the run may already be over, or the peer unreachable). */
export async function cancelOnPeer(peers: PeersCapability, h: PeerRunHandle): Promise<boolean> {
  try {
    const res = await peers.fetch(h.peer, `${runPath(h)}/cancel`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export interface TailPeerOpts {
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
  /** Consecutive failed attempts to (re)open the stream before giving up.
   *  Backoff doubles from 1 s to 30 s between them. */
  maxAttempts?: number;
  /** For tests: the sleeper between attempts. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TERMINAL = new Set<string>(["success", "error", "cancelled"]);

/** The stream's `done` frame as the peer sends it: a `RunResult` once the
 *  run has a summary, else its live state — `stale`, `running`, … */
interface DoneFrame {
  runId: string;
  status: string;
  output?: unknown;
  error?: { message: string };
}

/**
 * Follow a peer's run to its end over `GET …/stream`, reattaching after a
 * dropped connection with `?skip=<events read>`, and resolve with the
 * `done` frame's `RunResult`. Aborting `signal` rejects with an AbortError.
 *
 * A `done` that is not terminal is not an answer: `stale` means the peer's
 * run has no live process (cut off by a crash and not resumed) — retried
 * with the same backoff, since a peer mid-boot resumes its runs after it
 * starts serving, then `peer_run_stale:`; any other live state is the
 * summary not yet written behind the terminal event — reattached at once.
 */
export async function tailPeerRun(peers: PeersCapability, h: PeerRunHandle, opts: TailPeerOpts = {}): Promise<RunResult> {
  const { signal, onEvent } = opts;
  const maxAttempts = opts.maxAttempts ?? 20;
  const sleep = opts.sleep ?? defaultSleep;
  let seen = 0;
  let failures = 0; // consecutive failed opens — reset by one that succeeds
  let staleChecks = 0; // `done { status: "stale" }` answers — never reset: each is a successful open
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };
  for (;;) {
    throwIfAborted();
    let res: Response;
    try {
      res = await peers.fetch(h.peer, `${runPath(h)}/stream?skip=${seen}`, {
        headers: { accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throwIfAborted();
      // `peer_unknown:` is not a connection fault.
      if (err instanceof Error && err.message.startsWith("peer_unknown:")) throw err;
      failures += 1;
      if (failures >= maxAttempts) {
        throw new Error(
          `peer_unreachable: could not reach peer "${h.peer}" for run ${h.runId} after ${failures} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(backoffMs(failures));
      continue;
    }
    if (!res.ok) {
      // A refusal, not a drop: an unknown run, a revoked token. A 5xx is
      // a peer (or its proxy) mid-restart — retried like a drop.
      if (res.status < 500) {
        throw new Error(`peer "${h.peer}" refused GET ${runPath(h)}/stream (${res.status}): ${await errorText(res)}`);
      }
      await res.body?.cancel().catch(() => undefined);
      failures += 1;
      if (failures >= maxAttempts) throw new Error(`peer_unreachable: peer "${h.peer}" answered ${res.status} to the tail of run ${h.runId}, ${failures} times`);
      await sleep(backoffMs(failures));
      continue;
    }
    failures = 0;
    let result: DoneFrame | null;
    try {
      result = await readSse(res, (event) => {
        seen += 1;
        onEvent?.(event);
      });
    } catch (err) {
      throwIfAborted();
      // Dropped mid-stream: reattach from what was read.
      await sleep(backoffMs(1));
      continue;
    }
    if (result && TERMINAL.has(result.status)) return result as RunResult;
    throwIfAborted();
    if (result?.status === "stale") {
      staleChecks += 1;
      if (staleChecks >= maxAttempts) {
        throw new Error(
          `peer_run_stale: run ${h.runId} on peer "${h.peer}" has no live process there and was not resumed (${staleChecks} checks) — resume it on the peer, or launch again`,
        );
      }
      await sleep(backoffMs(staleChecks));
      continue;
    }
    // Closed cleanly without `done` (a proxy's idle timeout), or a `done`
    // whose summary was not written yet: reattach.
    await sleep(backoffMs(1));
  }
}

/** Launch on the peer and wait for the result — what the step and the
 *  chat tool return. */
export async function runOnPeer(peers: PeersCapability, launch: PeerLaunch, opts: TailPeerOpts = {}): Promise<PeerRunResult> {
  const startedAt = Date.now();
  const handle = await launchOnPeer(peers, launch);
  const result = await tailPeerRun(peers, handle, opts);
  return {
    ...handle,
    status: result.status,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error ? { error: { message: result.error.message } } : {}),
    durationMs: Date.now() - startedAt,
  };
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function abortError(): Error {
  const e = new Error("the tail was aborted");
  e.name = "AbortError";
  return e;
}

/** Read one SSE response: every unnamed `data:` frame is an event; the
 *  `done` frame is the result. Null when the stream ended without one. */
async function readSse(res: Response, onEvent: (event: RunEvent) => void): Promise<DoneFrame | null> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("the tail has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return null;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const data = JSON.parse(line.slice(5).trim()) as unknown;
        if (eventType === "done") {
          await reader.cancel().catch(() => undefined);
          return data as DoneFrame;
        }
        onEvent(data as RunEvent);
        eventType = "message";
      }
    }
  }
}

// ── reads the builder's `peer`-taking tools make ──────────────────────────

/** `GET {peer}/workflows?q=` in the shape of the builder's list_workflows. */
export async function listPeerWorkflows(peers: PeersCapability, peer: string, query = "", limit = 100) {
  const res = await peers.fetch(peer, `/workflows${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  if (!res.ok) throw new Error(`peer "${peer}" refused GET /workflows (${res.status}): ${await errorText(res)}`);
  const all = (await res.json()) as Array<{
    name: string;
    activeVersion?: string;
    description?: string;
    category?: string;
    publisher?: string;
  }>;
  const workflows = all.slice(0, limit).map((w) => ({
    name: w.name,
    activeVersion: w.activeVersion,
    ...(w.description ? { description: w.description } : {}),
    ...(w.category ? { category: w.category } : {}),
    ...(w.publisher ? { publisher: w.publisher } : {}),
  }));
  const total = all.length;
  return {
    peer,
    workflows,
    total,
    ...(total > workflows.length
      ? { hint: `Showing ${workflows.length} of ${total} workflows on peer "${peer}" — pass query (keywords) or raise limit.` }
      : {}),
  };
}

/** `GET {peer}/workflows/:name` + `/:version` in the shape of get_workflow. */
export async function readPeerWorkflow(peers: PeersCapability, peer: string, name: string, version?: string) {
  const metaRes = await peers.fetch(peer, `/workflows/${encodeURIComponent(name)}`);
  if (metaRes.status === 404) return { peer, error: `Workflow "${name}" not found on peer "${peer}"` };
  if (!metaRes.ok) throw new Error(`peer "${peer}" refused GET /workflows/${name} (${metaRes.status}): ${await errorText(metaRes)}`);
  const meta = (await metaRes.json()) as {
    active: string;
    versions: Record<string, { description?: string }>;
    publisher?: string;
  };
  const versions = Object.keys(meta.versions);
  const resolved = version ?? meta.active;
  const srcRes = await peers.fetch(peer, `/workflows/${encodeURIComponent(name)}/${encodeURIComponent(resolved)}`);
  if (!srcRes.ok) {
    return { peer, error: `Version "${resolved}" not found for "${name}" on peer "${peer}". Available: ${versions.join(", ")}` };
  }
  return {
    peer,
    name,
    version: resolved,
    activeVersion: meta.active,
    versions,
    description: meta.versions[meta.active]?.description,
    ...(meta.publisher ? { publisher: meta.publisher } : {}),
    yaml: await srcRes.text(),
  };
}
