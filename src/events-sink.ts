/**
 * The events sink — every run's events, the ENVELOPE only, batched and
 * POSTed to one URL the deployment names (`STRUT_EVENTS_SINK`,
 * `createStrut({ eventsSink })`): telemetry for a server that draws what
 * strut is doing — which workflow is running, which step lit up, how long it
 * took, what it spent — set once, for every run whoever launched it.
 *
 * The per-launch callbacks (callback.ts) carry a RESULT to the caller that
 * asked for it; this carries every event to a listener that asked once.
 * Three rules keep it from ever changing what a run is:
 *
 *  - The envelope, never the payload (`slimRunEvent`): type, when, which run
 *    and step, how long, what it spent, which version — never `input`,
 *    `output`, `messages`, `params`, the nodes a step touched or an error's
 *    stack. Nothing a workflow HANDLED leaves on it; a listener that needs
 *    more reads the run by id, with the key. An allowlist, so a field added
 *    to `RunEvent` later never leaves by accident.
 *  - Batched and detached: queued, flushed about once a second (or at 100),
 *    one POST in flight at a time so batches land in order; nothing in a run
 *    waits on a delivery.
 *  - Telemetry, not the record: a batch that cannot be delivered is retried
 *    briefly, then DROPPED (postCallback's rules), and a queue the listener
 *    cannot keep up with loses its oldest. The run log is the source of
 *    truth; a listener that missed a batch backfills from `GET …/runs`.
 */
import type { RunEvent } from "./core.js";
import { callbackOrigin, parseCallback, postCallback, type PostCallbackOptions } from "./callback.js";

/** What leaves on the sink: the fields of a `RunEvent` that say WHAT ran,
 *  WHEN, HOW LONG and WHAT IT SPENT — never what it handled. */
export const SINK_FIELDS = [
  "ts",
  "runId",
  "path",
  "type",
  "stepType",
  "durationMs",
  "iteration",
  "workflowHash",
  "stepVersion",
  "cassette",
  "origin",
  "automation",
  "actor",
  "principal",
  "job",
  "app",
  "verify",
  "subflow",
  "parentRunId",
  "toolCallId",
  "modelCalls",
  "usage",
  "cost",
] as const satisfies readonly (keyof RunEvent)[];

/** One event as the sink posts it: the run's store key beside the envelope.
 *  A run's spend is the sum of its `step.end` events' `modelCalls` / `usage`
 *  / `cost`, as `RunSummary.totals` is computed (store.ts `tallyUsage`). */
export type SinkEvent = { workflow: string } & Pick<RunEvent, (typeof SINK_FIELDS)[number]> & {
  /** The message alone — a stack is the server's business. */
  error?: { message: string };
};

/** The body of each POST. `event` is the discriminator the other posts
 *  carry (`run.end`, `job.update`, `turn.end`), so one URL can take them all. */
export interface SinkBatch {
  event: "run.events";
  events: SinkEvent[];
}

/** The envelope of one event — see `SINK_FIELDS`. */
export function slimRunEvent(workflow: string, event: RunEvent): SinkEvent {
  const out: Record<string, unknown> = { workflow };
  for (const key of SINK_FIELDS) {
    const v = event[key];
    if (v !== undefined) out[key] = v;
  }
  if (event.error) out["error"] = { message: event.error.message };
  return out as SinkEvent;
}

/** The sink URL: http(s), like a callback's; anything else fails the boot. */
export function parseSinkUrl(raw: unknown): string {
  try {
    return parseCallback({ url: raw }).url;
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).replace(/^callback\.url ?/, "");
    throw new Error(`eventsSink.url (STRUT_EVENTS_SINK) ${why}`);
  }
}

export interface EventsSinkOptions {
  url: string;
  fetch?: typeof fetch;
  /** How long queued events wait for company before a POST (ms). */
  flushMs?: number;
  /** Events per POST; a queue this full posts at once. */
  maxBatch?: number;
  /** Events held while deliveries lag; past it the oldest are dropped. */
  maxQueue?: number;
  retryDelaysMs?: number[];
}

export interface EventsSink {
  /** Queue one run event. Synchronous and never throws: a run never waits on it. */
  push(workflow: string, event: RunEvent): void;
  /** POST what is queued; resolves once everything queued so far was delivered or given up on. */
  flush(): Promise<void>;
  /** Stop the timer and flush; a later push posts at once. */
  close(): Promise<void>;
}

export function createEventsSink(opts: EventsSinkOptions): EventsSink {
  const { url } = opts;
  const flushMs = opts.flushMs ?? 1_000;
  const maxBatch = opts.maxBatch ?? 100;
  const maxQueue = opts.maxQueue ?? 10_000;
  const post: PostCallbackOptions = {
    tag: "[events-sink]",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    retryDelaysMs: opts.retryDelaysMs ?? [1_000, 5_000],
  };
  const queue: SinkEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let draining: Promise<void> | null = null;
  let closed = false;
  let dropped = 0;

  // One drain at a time, batches in queue order; a push during a POST is
  // picked up by the same loop.
  const drain = async () => {
    while (queue.length) {
      const events = queue.splice(0, maxBatch);
      await postCallback(url, { event: "run.events", events } satisfies SinkBatch, post);
    }
    if (dropped) {
      console.warn(`[events-sink] → ${callbackOrigin(url)} fell behind: ${dropped} queued event(s) were dropped.`);
      dropped = 0;
    }
  };
  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!draining) draining = drain().finally(() => (draining = null));
    return draining;
  };

  return {
    push(workflow, event) {
      if (queue.length >= maxQueue) {
        queue.shift();
        dropped++;
      }
      queue.push(slimRunEvent(workflow, event));
      if (closed || queue.length >= maxBatch) void flush();
      else if (!timer) {
        timer = setTimeout(() => void flush(), flushMs);
        timer.unref?.();
      }
    },
    flush,
    async close() {
      closed = true;
      await flush();
    },
  };
}
