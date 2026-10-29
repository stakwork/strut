/**
 * A package's DETAIL — what a release holds, read off its archive
 * (plans/marketplace.md §7, the store front): the apps with their titles,
 * each workflow with its inputs and what it can do, the steps with the
 * secrets they read and what the lint says, the Concept pages, the README.
 * The index derives it at the crawl and the store's package page draws it,
 * so a person sees an app before the package under it.
 *
 * A READING, never a check: nothing here is loaded or run — a step's facts
 * are regexes over its source, a workflow's over its YAML — and an install
 * re-reads everything through the real parsers. What it says of a workflow:
 *
 * | Flag     | When |
 * | -------- | ---- |
 * | `spends` | the closure holds an `agent`, `llm` or `acp/prompt` step |
 * | `acts`   | a step this strut knows declares `effect: "write"`, or the package's own step says so in its source |
 * | `code`   | an `exec` step, or one of the package's own steps (TypeScript in the installing process) |
 *
 * A subflow inside the package folds its child's flags in (package-first,
 * as the runner resolves it); one outside the package is listed and read
 * no further. An app's flags are its granted workflows'.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest as parseAppManifest } from "../apps/manifest.js";
import { walkSteps } from "../closure.js";
import { parseConceptFile } from "../concept-seed.js";
import type { Step, StepEffect } from "../core.js";
import { parseInputBlock } from "../input-block.js";
import { secretNamesIn } from "../reach.js";
import { lintStepSource } from "../step-lint.js";
import { baseType } from "../step-ref.js";
import { loadYaml } from "../yaml.js";
import type { CachedPackage } from "./cache.js";

/** What running a workflow (or an app over its workflows) reaches. */
export interface PackageCan {
  spends: boolean;
  acts: boolean;
  code: boolean;
}

export interface AppDetail {
  /** Inside the package: `issues` for `acme/linear/issues`. */
  name: string;
  title: string;
  description?: string;
  /** A lucide icon name, as the manifest says. */
  icon?: string;
  grants: { workflows: string[]; steps: string[] };
  can: PackageCan;
  files: number;
}

export interface WorkflowInputDetail {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  default?: unknown;
}

export interface WorkflowDetail {
  name: string;
  /** A top-level `description:` in the YAML, when the author wrote one. */
  description?: string;
  inputs: WorkflowInputDetail[];
  /** Step types in the closure, as written, deduped in order — a subflow's
   *  child as `subflow:<name>`. */
  steps: string[];
  /** `agentTools` grants, as written (a template kept as its text). */
  grants: string[];
  can: PackageCan;
  /** Secret NAMES the steps name in their config (`secretsEnv`, a
   *  `tokenSecret`, `http/verify`'s `{NAME}`), plus what the steps declare. */
  secrets: string[];
  peer?: true | "person";
  sealed?: true;
  /** How many claims the `claims:` block declares. */
  claims?: number;
  /** The YAML could not be read as a workflow. */
  error?: string;
}

export interface StepDetail {
  name: string;
  helper?: true;
  description?: string;
  effect?: StepEffect;
  secrets: string[];
  /** The lint's findings, one line each; empty = clean. */
  lint: string[];
  bytes: number;
  claims?: number;
}

export interface ConceptDetail {
  name: string;
  description?: string;
  parent?: string;
  docs?: string;
}

export interface PackageDetail {
  digest: string;
  version: string;
  derivedAt: string;
  /** `README.md` at the root, cut at `README_MAX_CHARS`. */
  readme?: string;
  apps: AppDetail[];
  workflows: WorkflowDetail[];
  steps: StepDetail[];
  concepts: ConceptDetail[];
  /** Every secret the package needs: the manifest's `requires.secrets` and
   *  what the workflows and steps name. */
  secrets: string[];
  can: PackageCan;
  files: number;
  bytes: number;
}

/** What this strut knows of a step type (its registry): for the flags and
 *  the secrets of a lib step a workflow uses. */
export interface StepFacts {
  effect?: StepEffect;
  secrets?: string[];
  description?: string;
}

export interface DetailDeps {
  stepInfo?: (type: string) => StepFacts | undefined;
}

export const README_MAX_CHARS = 64_000;
const DOCS_MAX_CHARS = 32_000;
const SPENDING_STEPS = new Set(["agent", "llm", "acp/prompt"]);

/** Regexes over a step's SOURCE — a reading of `defineStep({ … })` without
 *  loading it: its description, `effect`, declared `secrets`, and every
 *  `secrets.get("NAME")`. */
export function stepFactsFromSource(source: string): StepFacts {
  const out: StepFacts = {};
  const desc = /\bdescription:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(source);
  if (desc?.[2]) out.description = desc[2].replace(/\\(.)/g, "$1").slice(0, 300);
  const effect = /\beffect:\s*["'](read|write)["']/.exec(source);
  if (effect) out.effect = effect[1] as StepEffect;
  const names = new Set<string>();
  const declared = /\bsecrets:\s*\[([^\]]*)\]/.exec(source);
  if (declared) for (const m of declared[1]!.matchAll(/["'`]([A-Z][A-Z0-9_]*)["'`]/g)) names.add(m[1]!);
  for (const m of source.matchAll(/secrets\??\.get\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g)) names.add(m[1]!);
  if (names.size) out.secrets = [...names].sort();
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const countOf = (v: unknown): number | undefined => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : undefined);
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

interface FlowReading {
  name: string;
  data: Record<string, unknown> | null;
  steps: Step[];
  error?: string;
}

/** Read the package in `info.dir` into its detail. Never throws for a file
 *  it cannot read as its kind: that item carries an `error` instead. */
export async function derivePackageDetail(info: CachedPackage, deps: DetailDeps = {}): Promise<PackageDetail> {
  const pkg = info.manifest.package;
  const inside = (name: string) => (name.startsWith(`${pkg}/`) ? name.slice(pkg.length + 1) : name);
  const text = (path: string) => readFile(join(info.dir, path), "utf-8");

  // The package's own steps, by their names inside it, read first: a
  // workflow's flags and secrets lean on them.
  const stepItems = info.items.filter((i) => i.kind === "step");
  const stepSources = new Map<string, string>();
  const steps: StepDetail[] = [];
  for (const item of stepItems) {
    const name = inside(item.name);
    const source = await text(item.path);
    stepSources.set(name, source);
    const facts = stepFactsFromSource(source);
    const detail: StepDetail = {
      name,
      ...(item.helper ? { helper: true } : {}),
      ...(facts.description ? { description: facts.description } : {}),
      ...(facts.effect ? { effect: facts.effect } : {}),
      secrets: facts.secrets ?? [],
      lint: lintStepSource(source).map((f) => `line ${f.line}: ${f.message}`),
      bytes: Buffer.byteLength(source),
    };
    if (item.claims) {
      try {
        const n = countOf(loadYaml(await text(item.claims)));
        if (n !== undefined) detail.claims = n;
      } catch {
        /* a claims file that does not parse: the install reports it */
      }
    }
    steps.push(detail);
  }
  const ownStep = (type: string): string | undefined => {
    const bare = baseType(type);
    if (stepSources.has(bare)) return bare;
    if (bare.startsWith(`${pkg}/`) && stepSources.has(bare.slice(pkg.length + 1))) return bare.slice(pkg.length + 1);
    return undefined;
  };
  const factsOf = (type: string): StepFacts | undefined => {
    const own = ownStep(type);
    if (own) return stepFactsFromSource(stepSources.get(own)!);
    return deps.stepInfo?.(baseType(type));
  };

  // The workflows: read once, flags folded over subflows inside the package.
  const readings = new Map<string, FlowReading>();
  for (const item of info.items.filter((i) => i.kind === "workflow")) {
    const name = inside(item.name);
    let raw: unknown;
    try {
      raw = loadYaml(await text(item.path));
    } catch (err) {
      readings.set(name, { name, data: null, steps: [], error: `not valid YAML — ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const stepList = Array.isArray(data?.["steps"]) ? (data!["steps"] as Step[]) : [];
    readings.set(name, { name, data, steps: stepList, ...(data && stepList.length ? {} : { error: "no steps: line — not a workflow" }) });
  }
  const childOf = (ref: unknown): string | undefined => {
    if (typeof ref !== "string" || !ref.trim()) return undefined;
    const bare = ref.startsWith(`${pkg}/`) ? ref.slice(pkg.length + 1) : ref;
    return readings.has(bare) ? bare : undefined;
  };
  const folded = new Map<string, WorkflowDetail>();
  const fold = (name: string, trail: string[]): WorkflowDetail => {
    const have = folded.get(name);
    if (have) return have;
    const r = readings.get(name)!;
    const types: string[] = [];
    const grants: string[] = [];
    const secrets = new Set<string>();
    const can: PackageCan = { spends: false, acts: false, code: false };
    const seen = new Set<string>();
    const addType = (t: string) => {
      if (!seen.has(t)) {
        seen.add(t);
        types.push(t);
      }
    };
    walkSteps(r.steps, (s) => {
      const type = baseType(s.type);
      const cfg = (s.config ?? {}) as Record<string, unknown>;
      if (type === "subflow") {
        const child = childOf(cfg["workflow"]);
        addType(`subflow:${typeof cfg["workflow"] === "string" ? inside(cfg["workflow"]) : "?"}`);
        if (child && !trail.includes(child)) {
          const c = fold(child, [...trail, name]);
          can.spends ||= c.can.spends;
          can.acts ||= c.can.acts;
          can.code ||= c.can.code;
          for (const t of c.steps) addType(t);
          for (const g of c.grants) if (!grants.includes(g)) grants.push(g);
          for (const sec of c.secrets) secrets.add(sec);
        }
        return;
      }
      // A step named with the package's prefix reads as the package names it.
      addType(inside(type));
      if (SPENDING_STEPS.has(type)) can.spends = true;
      if (type === "exec" || ownStep(type)) can.code = true;
      const facts = factsOf(type);
      if (facts?.effect === "write") can.acts = true;
      // A lib step's declared secrets are alternatives (any one suffices):
      // only a step with exactly one names a secret the workflow needs.
      if (facts?.secrets?.length === 1 && !ownStep(type)) secrets.add(facts.secrets[0]!);
      if (ownStep(type)) for (const sec of facts?.secrets ?? []) secrets.add(sec);
      for (const sec of secretNamesIn(cfg)) if (typeof sec === "string" && SECRET_NAME.test(sec)) secrets.add(sec);
      if (type === "agent") {
        let tools = cfg["agentTools"];
        // `agentTools: "{{ params.tools }}"` — read off the params' defaults.
        if (typeof tools === "string") {
          const m = /^\s*\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(tools);
          const params = r.data?.["params"] as Record<string, unknown> | undefined;
          if (m && Array.isArray(params?.[m[1]!])) tools = params![m[1]!];
        }
        const list = Array.isArray(tools) ? tools : tools === undefined ? [] : [tools];
        for (const g of list) {
          const t = typeof g === "string" ? inside(g) : JSON.stringify(g);
          if (!grants.includes(t)) grants.push(t);
          if (typeof g === "string" && !g.includes("*")) {
            if (SPENDING_STEPS.has(g)) can.spends = true;
            if (ownStep(g) || g === "exec") can.code = true;
            if (factsOf(g)?.effect === "write") can.acts = true;
          }
        }
      }
    });
    let inputs: WorkflowInputDetail[] = [];
    let inputError: string | undefined;
    if (r.data?.["input"] != null) {
      try {
        inputs = Object.entries(parseInputBlock(r.data["input"])).map(([n, f]) => ({
          name: n,
          type: f.type,
          required: f.required ?? f.default === undefined,
          ...(f.description ? { description: f.description } : {}),
          ...(f.default !== undefined ? { default: f.default } : {}),
        }));
      } catch (err) {
        inputError = `input: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const peer = r.data?.["peer"];
    const claims = countOf(r.data?.["claims"]);
    const error = r.error ?? inputError;
    const detail: WorkflowDetail = {
      name,
      ...(str(r.data?.["description"]) ? { description: str(r.data!["description"]) } : {}),
      inputs,
      steps: types,
      grants,
      can,
      secrets: [...secrets].sort(),
      ...(peer === true || peer === "person" ? { peer } : {}),
      ...(r.data?.["sealed"] === true ? { sealed: true } : {}),
      ...(claims !== undefined ? { claims } : {}),
      ...(error ? { error } : {}),
    };
    folded.set(name, detail);
    return detail;
  };
  const workflows = [...readings.keys()].sort().map((n) => fold(n, []));
  const workflowByName = new Map(workflows.map((w) => [w.name, w]));

  // The apps: the manifest's face, the flags of what they may launch.
  const apps: AppDetail[] = [];
  for (const item of info.items.filter((i) => i.kind === "app")) {
    const name = inside(item.name);
    const files = info.files.filter((f) => f.startsWith(`${item.path}/`)).length;
    let manifestText: string;
    try {
      manifestText = await text(`${item.path}/app.yaml`);
    } catch {
      apps.push({ name, title: name, grants: { workflows: [], steps: [] }, can: { spends: false, acts: false, code: false }, files });
      continue;
    }
    const read = parseAppManifest(manifestText);
    if (!read.ok) {
      apps.push({ name, title: name, description: read.errors.join("; "), grants: { workflows: [], steps: [] }, can: { spends: false, acts: false, code: false }, files });
      continue;
    }
    const m = read.manifest;
    const can: PackageCan = { spends: false, acts: false, code: false };
    for (const w of m.grants.workflows) {
      const child = workflowByName.get(childOf(w) ?? "");
      if (!child) continue;
      can.spends ||= child.can.spends;
      can.acts ||= child.can.acts;
      can.code ||= child.can.code;
    }
    for (const s of m.grants.steps) {
      if (s.includes("*")) continue;
      if (SPENDING_STEPS.has(s)) can.spends = true;
      if (s === "exec" || ownStep(s)) can.code = true;
      if (factsOf(s)?.effect === "write") can.acts = true;
    }
    apps.push({
      name,
      title: m.title,
      ...(m.description ? { description: m.description } : {}),
      ...(m.icon ? { icon: m.icon } : {}),
      grants: { workflows: [...m.grants.workflows], steps: [...m.grants.steps] },
      can,
      files,
    });
  }

  // The Concept pages, docs capped.
  const concepts: ConceptDetail[] = [];
  for (const item of info.items.filter((i) => i.kind === "concept")) {
    const page = parseConceptFile(item.path.slice("concepts/".length), await text(item.path), "");
    concepts.push({
      name: page.name,
      ...(page.description ? { description: page.description } : {}),
      ...(page.parent ? { parent: page.parent } : {}),
      ...(page.docs ? { docs: page.docs.length > DOCS_MAX_CHARS ? `${page.docs.slice(0, DOCS_MAX_CHARS)}\n\n…` : page.docs } : {}),
    });
  }

  // The README: the root's, any case.
  const readmeFile = info.files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f));
  let readme: string | undefined;
  if (readmeFile) {
    const t = await text(readmeFile);
    readme = t.length > README_MAX_CHARS ? `${t.slice(0, README_MAX_CHARS)}\n\n… (cut at ${README_MAX_CHARS} characters)` : t;
  }

  let bytes = 0;
  for (const f of info.files) bytes += (await stat(join(info.dir, f))).size;

  const secrets = new Set<string>(info.manifest.requires?.secrets ?? []);
  for (const w of workflows) for (const s of w.secrets) secrets.add(s);
  for (const s of steps) for (const sec of s.secrets) secrets.add(sec);
  const can: PackageCan = {
    spends: workflows.some((w) => w.can.spends) || apps.some((a) => a.can.spends),
    acts: workflows.some((w) => w.can.acts) || apps.some((a) => a.can.acts),
    code: workflows.some((w) => w.can.code) || apps.some((a) => a.can.code) || steps.some((s) => !s.helper),
  };
  return {
    digest: info.digest,
    version: info.manifest.version,
    derivedAt: new Date().toISOString(),
    ...(readme !== undefined ? { readme } : {}),
    apps: apps.sort((a, b) => a.name.localeCompare(b.name)),
    workflows,
    steps: steps.sort((a, b) => a.name.localeCompare(b.name)),
    concepts: concepts.sort((a, b) => a.name.localeCompare(b.name)),
    secrets: [...secrets].sort(),
    can,
    files: info.files.length,
    bytes,
  };
}

/** The short form a search hit carries: the apps' faces and the counts. */
export interface DetailSummary {
  apps: Array<{ name: string; title: string; description?: string; icon?: string; can: PackageCan }>;
  workflows: number;
  steps: number;
  concepts: number;
  secrets: string[];
  can: PackageCan;
  readme: boolean;
}

export function summarizeDetail(d: PackageDetail): DetailSummary {
  return {
    apps: d.apps.map((a) => ({ name: a.name, title: a.title, ...(a.description ? { description: a.description } : {}), ...(a.icon ? { icon: a.icon } : {}), can: a.can })),
    workflows: d.workflows.length,
    steps: d.steps.filter((s) => !s.helper).length,
    concepts: d.concepts.length,
    secrets: d.secrets,
    can: d.can,
    readme: d.readme !== undefined,
  };
}
