import { z } from "zod";
import { coerceJsonArg, defineStep, type RunEvent, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { RemoteError, type RemoteRunHandle } from "../../../remote.js";
import { launchKeyOf, remoteOf, SPENDS_HELD_CREDIT, withCharge } from "./_shared.js";

/**
 * Run a WORKFLOW another strut server sells (plans/paid-runs.md §3, §10 —
 * the CVE case): `POST <seller>/public/workflows/:name/run`, the credit held
 * there presented, then the launcher's view read until the run ends.
 *
 * Never two runs for one: the launch carries a `key` — the step's own by
 * default, the same on a retry or a resume — and the seller returns the run
 * that key started while it is in flight. The handle is journaled at
 * `<path>#launch` (no run token in it: the remote door keeps that), so a
 * resume of this run waits on the run it launched, even one that ended
 * while this strut was down, instead of launching a second. Cancelling
 * this run cancels the remote one.
 *
 * A seller that does not answer is waited out (a restart, a proxy's 502):
 * the run is the seller's and charged whether or not it is read, so the
 * step never gives up on it — the run's cancel is the bound. A launch the
 * seller turns away for a moment (its in-flight limit, a drain, a lost
 * 202) is tried again under the same key. What the run was charged is
 * this step's cost (`withCharge`). Refused in a stranger's run or a peer's
 * (decision 16: no ask is for this strut's own agents).
 */

interface LaunchRecord {
  seller: string;
  workflow: string;
  runId: string;
  launchedAt: number;
}

function launchRecord(v: unknown): LaunchRecord | undefined {
  const r = v as Partial<LaunchRecord> | null;
  if (!r || typeof r !== "object" || typeof r.seller !== "string" || typeof r.workflow !== "string" || typeof r.runId !== "string" || !r.runId) return undefined;
  return { seller: r.seller, workflow: r.workflow, runId: r.runId, launchedAt: typeof r.launchedAt === "number" ? r.launchedAt : Date.now() };
}

export default defineStep({
  type: "remote/run-workflow",
  effect: "write",
  description:
    "Run a WORKFLOW another strut server sells to run — through its public door, with no peer record — and wait for its output. " +
    "Find what it sells and each workflow's input with remote/list first. Returns { seller, workflow, runId, status, output?, error?, charged_usd?, credit?, durationMs }: " +
    "`status` success | error | cancelled; `charged_usd` what the run was charged there (base + markup × its cost; a failed run its cost). " +
    SPENDS_HELD_CREDIT,
  input: z.object({
    url: z.string().describe("The seller: a strut server's base URL, https (what remote/list was given)."),
    workflow: z.string().min(1).describe("The workflow's name, as remote/list names it."),
    input: z.preprocess(coerceJsonArg, z.record(z.string(), z.unknown())).optional().describe("The run's input, as the workflow's `input` in remote/list asks."),
    key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Makes a retry safe: the seller returns the run this key started while it is in flight. Default: this step's own, the same on every retry."),
  }),
  output: z.object({
    seller: z.string(),
    workflow: z.string(),
    runId: z.string(),
    status: z.string(),
    output: z.any().optional(),
    error: z.object({ message: z.string() }).optional(),
    charged_usd: z.number().optional(),
    credit: z.any().optional(),
    durationMs: z.number().optional(),
    existing: z.boolean().optional(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const remote = remoteOf(ctx, "remote/run-workflow");
    const seller = remote.seller(cfg.url);
    const key = cfg.key ?? launchKeyOf(ctx);
    const launchKey = ctx.path ? `${ctx.path}#launch` : undefined;
    const prior = launchKey ? launchRecord(ctx.journal?.[launchKey]) : undefined;
    const journaled = prior && prior.seller === seller && prior.workflow === cfg.workflow ? prior : undefined;

    // Cancel: cooperative, the remote run one unit — tell the seller, stop
    // waiting (or trying to launch), then let checkpoint() raise the
    // canonical CancelledError.
    const ac = new AbortController();
    const control = ctx.control;
    let handle: RemoteRunHandle | undefined;
    let settled = false;
    const watch = control
      ? setInterval(() => {
          if (control.state === "cancelling" && !ac.signal.aborted) {
            if (handle) void remote.cancel(handle);
            ac.abort();
          }
        }, 200)
      : undefined;
    // This run ending for another reason takes the remote run with it.
    ctx.onRunEnd?.(async () => {
      if (!settled && handle) await remote.cancel(handle);
    });

    const launch = async (): Promise<{ handle: RemoteRunHandle; launchedAt: number }> => {
      const launchedAt = Date.now();
      const handle = await remote.launch(seller, cfg.workflow, {
        ...(cfg.input !== undefined ? { input: cfg.input } : {}),
        key,
        ...(control ? { control } : {}),
        signal: ac.signal,
      });
      // The handle, journaled before the wait (strut/run-workflow's slot):
      // a resume reads this run instead of launching another.
      if (launchKey && ctx.emit) {
        const record: LaunchRecord = { seller, workflow: cfg.workflow, runId: handle.runId, launchedAt };
        await (ctx.emit as unknown as (e: Partial<RunEvent> & { type: RunEvent["type"] }) => Promise<void>)({ type: "step.end", path: launchKey, output: record });
      }
      return { handle, launchedAt };
    };

    let launchedAt = journaled?.launchedAt ?? Date.now();
    try {
      if (journaled) handle = { seller, workflow: cfg.workflow, runId: journaled.runId };
      else ({ handle, launchedAt } = await launch());
      let view;
      try {
        view = await remote.wait(handle, { signal: ac.signal });
      } catch (err) {
        // A journaled run whose token this strut no longer holds: launch
        // again under the same key — the seller returns it while in flight.
        if (!(journaled && err instanceof RemoteError && err.code === "run_unknown")) throw err;
        ({ handle, launchedAt } = await launch());
        view = await remote.wait(handle, { signal: ac.signal });
      }
      settled = true;
      await remote.release(handle);
      return withCharge({
        seller,
        workflow: cfg.workflow,
        runId: handle.runId,
        status: view.status,
        ...(view.output !== undefined ? { output: view.output } : {}),
        ...(view.error ? { error: view.error } : {}),
        ...(view.charged !== undefined ? { charged_usd: view.charged } : {}),
        ...(handle.credit ? { credit: handle.credit } : {}),
        durationMs: view.durationMs ?? Date.now() - launchedAt,
        ...(handle.existing ? { existing: true } : {}),
      }, view.charged);
    } catch (err) {
      if (ac.signal.aborted && control) {
        settled = true; // the cancel was delivered above
        if (handle) await remote.release(handle);
        await control.checkpoint();
      }
      // A run the seller does not know is over for this step; any other
      // failure keeps the token, so a retry or a resume reads the run.
      if (handle && err instanceof RemoteError && err.code === "run_unknown") await remote.release(handle);
      throw err;
    } finally {
      if (watch) clearInterval(watch);
    }
  },
});
