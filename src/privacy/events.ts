import type { StepContext } from "./host.js";

/** Counts only: how many values of each type were masked, never a value. */
export async function emitMasked(ctx: StepContext | undefined, e: { counts: Record<string, number>; late_entities: number; epoch: number; mode: string }): Promise<void> {
  if (!ctx?.emit || (!Object.keys(e.counts).length && !e.late_entities)) return;
  try {
    await (ctx.emit as unknown as (e: Record<string, unknown>) => Promise<void>)({ type: "privacy.masked", path: ctx.path, ...e });
  } catch { /* telemetry never fails a call */ }
}
