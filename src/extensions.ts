// ── Extension points: generic seams a feature registers into ────────────────
//
// Core knows three things and nothing about any feature behind them:
//   - a MODEL WRAPPER: `resolveModel` (src/llm.ts) hands every model it builds to
//     the registered wrappers, which may return a wrapped one;
//   - a TOOL WRAPPER: the agent step hands every tool set to the registered
//     wrappers, which may wrap tools' `execute` in place;
//   - a SETTING: a named, schema-checked knob that a deployment, a workflow, a
//     run or a step sets, resolved per step into `ctx.settings`.
// Nothing registered means every function below returns what it was given.

import type { ZodTypeAny } from "zod";
import type { StepContext } from "./core.js";

/** What a wrapper is told about the call a model is built for. */
export interface ModelCallInfo {
  provider: string;
  modelId: string;
  /** Where the call goes when something other than the provider's own API does. */
  baseUrl?: string;
  /** True when a gateway grant sent the call somewhere (it returned a `baseUrl`). */
  routed: boolean;
  ctx?: StepContext<unknown>;
  /** The agent session the model is built for, when the step has one. */
  session?: string;
}

export type ModelWrapper = (model: any, info: ModelCallInfo) => any | Promise<any>;
export type ToolWrapper = (tools: Record<string, any>, ctx?: StepContext<any>) => void;
export interface SettingDef {
  key: string;
  schema: ZodTypeAny;
  /** Turns a short form into the one the feature reads. */
  normalize?: (value: any) => unknown;
}

const modelWrappers: ModelWrapper[] = [];
const toolWrappers: ToolWrapper[] = [];
const settings = new Map<string, SettingDef>();

export const registerModelWrapper = (w: ModelWrapper): void => void modelWrappers.push(w);
export const registerToolWrapper = (w: ToolWrapper): void => void toolWrappers.push(w);
export const registerSetting = (d: SettingDef): void => void settings.set(d.key, d);

export async function applyModelWrappers(model: any, info: ModelCallInfo): Promise<any> {
  for (const w of modelWrappers) model = await w(model, info);
  return model;
}

export function applyToolWrappers(tools: Record<string, any>, ctx?: StepContext<any>): void {
  for (const w of toolWrappers) w(tools, ctx);
}

/** Highest level wins, per key and whole (no deep merge): step > run > workflow > deployment. */
export function resolveSettings(l: { deployment?: unknown; workflow?: unknown; step?: unknown; run?: unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const level of [l.deployment, l.workflow, l.run, l.step]) {
    if (level && typeof level === "object" && !Array.isArray(level)) Object.assign(out, level);
  }
  for (const [k, def] of settings) if (k in out && def.normalize) out[k] = def.normalize(out[k]);
  return out;
}

/** Problems with a settings block, one string each; an unknown key is one. */
export function validateSettings(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["`settings` must be a mapping of setting → value."];
  const errors: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const def = settings.get(k);
    if (!def) { errors.push(`unknown setting "${k}" (known: ${[...settings.keys()].join(", ") || "none"}).`); continue; }
    const r = def.schema.safeParse(v);
    if (!r.success) errors.push(`settings.${k}: ${r.error.issues.map((i) => i.message).join("; ")}`);
  }
  return errors;
}
