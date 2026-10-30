/**
 * The size a step may hand back.
 *
 * A step's output is recorded on its `step.end`, held in the run's scope
 * until the run ends, and read back whole by the journal replay, the run
 * view, the projector and the verify pass — so a run whose steps return
 * hundreds of megabytes fills the heap of the serving process (swarm38,
 * 2026-10-30: 100–245 MB run logs, GC storms, then a crash loop through
 * boot-time auto-resume). Over the cap a step FAILS, as a normal step
 * error (retry and onError apply), with the convention AGENTS.md's
 * "Artifacts" section states: large data goes in a file under
 * `ctx.services.artifacts`, its RELATIVE path in the output. The same cap
 * holds for a loop or foreach iteration's output and for what an agent's
 * tool returns (`wrapToolsWithEmit`, steps/core/agent.ts) — a tool result is
 * held in the agent's transcript, on the model's context and in the session.
 */
import { bootEnv } from "./env.js";

/** `STRUT_STEP_OUTPUT_MAX_BYTES` unset: 8 MB. */
export const DEFAULT_STEP_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

/** The cap in force, read per call (a test sets the env). A value that is
 *  not a positive number is the default. */
export function stepOutputMaxBytes(): number {
  return positiveBytes(bootEnv()["STRUT_STEP_OUTPUT_MAX_BYTES"], DEFAULT_STEP_OUTPUT_MAX_BYTES);
}

/** A byte count from an env value, or `fallback` for anything but a positive number. */
export function positiveBytes(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** The bytes a value takes as JSON — what the run log and run.json hold.
 *  Markers (`withMessages`, `withMedia`) are non-enumerable and do not
 *  count; what JSON cannot serialize counts as nothing (the store would
 *  refuse that on its own). */
export function jsonBytes(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : Buffer.byteLength(s);
  } catch {
    return 0;
  }
}

/** The error for an output over the cap, or null. `what` names it in the
 *  message: `step output`, `tool result`. */
export function outputTooBig(output: unknown, what: string, cap = stepOutputMaxBytes()): Error | null {
  const bytes = jsonBytes(output);
  if (bytes <= cap) return null;
  return new Error(
    `output_too_large: ${what} is ${fmtBytes(bytes)} as JSON, over the ${fmtBytes(cap)} cap ` +
      `(STRUT_STEP_OUTPUT_MAX_BYTES). An output is recorded in the run log and held in memory for the ` +
      `whole run: write large data to a file under ctx.services.artifacts ` +
      `(write(ctx.runId, relPath, content)) and return its relative path instead.`,
  );
}

/** `12.3 MB (12912345 bytes)`, `812.0 KB (831488 bytes)`, `200 bytes`. */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB (${n} bytes)`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB (${n} bytes)`;
  return `${n} bytes`;
}
