/**
 * `app.yaml` — the manifest of an APP (plans/apps.md §1.1): what the build
 * reads at every build and the publish keeps on the version. Shape-checked
 * here with zod, the way a workflow's `input:` block is, so a bad manifest
 * is a build error a model can read (`manifest.ts: grants.steps[1]: …`),
 * never a document that fails later.
 *
 * `grants` is what the app may reach through `step_run` (§5): the
 * workflows it may read, launch and cancel (`run/*`), the step types it may
 * call, its own SQLite file, the schedules it may set. `data.graph` is the
 * node and edge types it declares (§4.3) — parsed and kept here, checked
 * against the graph at every build and registered at publish
 * (./graph-types.ts), and the only types a page may write. `csp.resourceDomains` are the only
 * places beyond `data:` and `blob:` the document may load an image, a font
 * or a media file from (§9). Nothing else is declared: an app has no
 * `connectDomains` — it talks to the world through a workflow.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadYaml } from "../yaml.js";

/** The manifest file's name in the directory. */
export const MANIFEST_FILE = "app.yaml";

/** `string | number | boolean | date | json`, `?`-suffixed when optional. */
const ATTR_RE = /^(string|number|boolean|date|json)\??$/;
export const attributeType = z.string().regex(ATTR_RE, "an attribute is string | number | boolean | date | json, with ? for optional");

/** The two keys of a type declaration that take a list of attribute names. */
export const TYPE_LISTS = ["search", "key"] as const;

/** One declared node type: its attributes, plus `search`, the fields the
 *  graph indexes, and `key`, the fields that identify a node — two nodes
 *  with the same key values are one node (default `[name]`; `name` is every
 *  type's, declared or not). */
export const graphTypeSchema = z
  .record(z.string(), z.union([attributeType, z.array(z.string())]))
  .superRefine((spec, ctx) => {
    for (const [k, v] of Object.entries(spec)) {
      if (Array.isArray(v) && !(TYPE_LISTS as readonly string[]).includes(k)) {
        ctx.addIssue({ code: "custom", path: [k], message: "only `search` (the attributes the graph indexes) and `key` (the attributes that identify a node) take a list" });
      }
      if (!Array.isArray(v) && (TYPE_LISTS as readonly string[]).includes(k)) {
        ctx.addIssue({ code: "custom", path: [k], message: `\`${k}\` is a list of attribute names, so it cannot be an attribute itself` });
      }
    }
    for (const list of TYPE_LISTS) {
      const names = spec[list];
      if (!Array.isArray(names)) continue;
      for (const f of names) {
        if (list === "key" && f === "name") continue;
        if (!(f in spec) || Array.isArray(spec[f])) ctx.addIssue({ code: "custom", path: [list], message: `${list} names "${f}", which is not an attribute of this type` });
      }
    }
    if (Array.isArray(spec["key"]) && spec["key"].length === 0) ctx.addIssue({ code: "custom", path: ["key"], message: "key needs at least one attribute (leave it out for [name])" });
  });

export const grantsSchema = z
  .object({
    /** The app's ROUTINES: `run/*` on these — read runs, launch, cancel. */
    workflows: z.array(z.string().min(1)).default([]),
    /** Step types (globs allowed, as `agentTools` takes them). */
    steps: z.array(z.string().min(1)).default([]),
    /** `sqlite/*` on the app's own database (§4.4). */
    sqlite: z.boolean().default(false),
    /** `automation/*` on these workflows' schedules. */
    automations: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const manifestSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    /** A lucide icon name. */
    icon: z.string().optional(),
    /** The entry module; its default export is the root component. */
    entry: z.string().min(1).default("src/App.tsx"),
    grants: grantsSchema.default({ workflows: [], steps: [], sqlite: false, automations: [] }),
    data: z
      .object({
        graph: z
          .object({
            types: z.record(z.string().regex(/^[A-Z][A-Za-z0-9_]*$/, "a node type is CapitalizedLikeThis"), graphTypeSchema).default({}),
            /** `[Source, EDGE_TYPE, Target]` triples. */
            edges: z.array(z.tuple([z.string(), z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an edge type is UPPER_SNAKE"), z.string()])).default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    csp: z
      .object({
        /** Origins the document may load images, fonts and media from. */
        resourceDomains: z.array(z.string().regex(/^https:\/\/[^\s'";]+$/, "a resource domain is an https:// origin")).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AppManifest = z.infer<typeof manifestSchema>;
export type AppGrants = AppManifest["grants"];

/** `grants.steps`, `grants.workflows`, … issues as one line each — what a
 *  build error and a model read. */
export function formatManifestIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((i) => {
    const path = i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "");
    return `${MANIFEST_FILE}: ${path ? `${path}: ` : ""}${i.message}`;
  });
}

export type ManifestResult = { ok: true; manifest: AppManifest } | { ok: false; errors: string[] };

/** Parse and check manifest TEXT. */
export function parseManifest(text: string): ManifestResult {
  let raw: unknown;
  try {
    raw = loadYaml(text);
  } catch (err) {
    return { ok: false, errors: [`${MANIFEST_FILE}: not valid YAML — ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (raw === null || raw === undefined) return { ok: false, errors: [`${MANIFEST_FILE}: empty — it needs at least a title`] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: [`${MANIFEST_FILE}: must be a mapping (title: …, grants: …)`] };
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatManifestIssues(parsed.error.issues) };
  const m = parsed.data;
  // Declared edges name declared types.
  const errors: string[] = [];
  for (const [i, [s, , t]] of (m.data?.graph?.edges ?? []).entries()) {
    for (const end of [s, t]) if (!m.data?.graph?.types[end]) errors.push(`${MANIFEST_FILE}: data.graph.edges[${i}]: "${end}" is not a declared type`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest: m };
}

/** Read and check the manifest in an app directory. */
export async function readManifest(dir: string): Promise<ManifestResult> {
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, errors: [`${MANIFEST_FILE}: not found — an app is a directory with an app.yaml at its top`] };
    throw err;
  }
  return parseManifest(text);
}
