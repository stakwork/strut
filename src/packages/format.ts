/**
 * A PACKAGE (plans/marketplace.md §1): a directory holding one namespace —
 * `strut.yaml`, a few hand-written lines, and the folders beside it, each
 * file an item named under the package's prefix:
 *
 *   workflows/<path>.yaml        → the workflow <package>/<path>
 *   steps/<path>.ts              → the step <package>/<path> (`_` files: helpers)
 *   steps/<path>.claims.yaml     → that step's claims
 *   concepts/<Name>.md           → the Concept page <Name>
 *   apps/<name>/                 → the app <package>/<name>, a directory with app.yaml
 *
 * Its DIGEST is the tree hash over every file in it, `strut.yaml` included
 * (`hashTree`, src/version.ts — an app's version hash is the same function
 * over its own directory, so an app's files are hashed alike in both). The
 * manifest holds nothing the files say: the items ARE the directory.
 *
 * `readPackage` reads one and refuses what it cannot install whole: an
 * unknown top-level folder (a package from a newer strut fails instead of
 * installing half), a file a folder does not hold, a name the prefix rule
 * does not allow, anything but a regular file. Whether the code loads, the
 * Concepts' parents resolve or an app builds is the install's to check; this
 * reads paths and the manifest only, and writes nothing.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { validateAppName } from "../apps/files.js";
import { hashTree } from "../version.js";
import { validateStepName, validateWorkflowName } from "../workspace.js";
import { loadYaml } from "../yaml.js";

export const MANIFEST_FILE = "strut.yaml";

/** `sha256:<64 hex>` — how a package is pinned. */
export const PACKAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A package name: `publisher/name`, lowercase, one slash — a convention,
 *  like a forge's `org/repo`, and the prefix every item is named under. */
export const PACKAGE_NAME = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

const packageName = z.string().regex(PACKAGE_NAME, "a package is named publisher/name: two lowercase segments, [a-z][a-z0-9-]*");
const names = z.array(z.string().min(1));

const manifestSchema = z
  .object({
    package: packageName,
    version: z.string().min(1),
    description: z.string().optional(),
    // An SPDX expression (`Apache-2.0`, `MIT OR Apache-2.0`, `LicenseRef-…`):
    // shown at install, never enforced, so its syntax is not checked here.
    license: z.string().min(1, "a license is an SPDX expression, e.g. Apache-2.0").optional(),
    requires: z
      .object({
        secrets: names.optional(),
        binaries: names.optional(),
        runtimes: z.array(z.object({ name: z.string().min(1), image: z.string().optional(), binaries: names.optional() }).strict()).optional(),
        packages: z
          .array(z.object({ package: packageName, digest: z.string().regex(PACKAGE_DIGEST, "a digest is sha256:<64 hex>"), source: z.string().min(1) }).strict())
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PackageManifest = z.infer<typeof manifestSchema>;

/** One item: what the install publishes. A workflow, step or app is named
 *  `<package>/<path>`; a Concept by its page name (its stamp carries the
 *  package, `seedConcepts`). `path` is the file, or the app's directory. */
export interface PackageItem {
  kind: "workflow" | "step" | "concept" | "app";
  name: string;
  path: string;
  /** A `_` step file: published with its namespace, never registered. */
  helper?: true;
  /** The step's `<name>.claims.yaml`. */
  claims?: string;
}

export interface PackageInfo {
  manifest: PackageManifest;
  /** `sha256:<hex>` over `files`. */
  digest: string;
  /** Every file the digest covers, sorted, `/`-joined. */
  files: string[];
  items: PackageItem[];
}

/** What a package digest leaves out, and an archive may never hold:
 *  dotfiles and `node_modules/` at any depth, and an app's derived document
 *  and its data (`apps/<name>/dist`, `apps/<name>/data.db`) — the
 *  `treeExcluded` rule of src/version.ts, applied inside each app. */
export function packageExcluded(relPath: string, name: string): boolean {
  if (name.startsWith(".") || name === "node_modules") return true;
  return /^apps\/[^/]+\/(?:dist|data\.db)$/.test(relPath);
}

/** Every file under `dir` the digest covers. Throws on a symlink or any
 *  other entry that is not a regular file or a folder. */
async function packageFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (packageExcluded(relPath, e.name)) continue;
      if (e.isDirectory()) await walk(relPath);
      else if (e.isFile()) out.push(relPath);
      else throw new Error(`bad_package: ${relPath} is not a regular file — a package holds files and folders only`);
    }
  };
  await walk("");
  return out.sort();
}

/** An item's name, held to the workspace's own rule for its kind: a
 *  workflow's (`validateWorkflowName`: no `runs` or `#` segment) or a step's
 *  (`validateStepName`: `[a-zA-Z_][a-zA-Z0-9_-]*` segments). */
function itemName(pkg: string, kind: "workflow" | "step", path: string): string {
  const name = `${pkg}/${path}`;
  (kind === "workflow" ? validateWorkflowName : validateStepName)(name);
  return name;
}

function parseManifest(text: string): PackageManifest {
  let raw: unknown;
  try {
    raw = loadYaml(text);
  } catch (err) {
    throw new Error(`bad_package: ${MANIFEST_FILE} is not valid YAML — ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = manifestSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => {
    const path = i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "");
    return `${MANIFEST_FILE}: ${path ? `${path}: ` : ""}${i.message}`;
  });
  throw new Error(`bad_package: ${issues.join("; ")}`);
}

/** Read the package in `dir`: its manifest, digest, files and items. Throws
 *  `bad_package: …` naming every problem it finds. */
export async function readPackage(dir: string): Promise<PackageInfo> {
  const files = await packageFiles(dir);
  if (!files.includes(MANIFEST_FILE)) throw new Error(`bad_package: no ${MANIFEST_FILE} at the top of the directory`);
  const manifest = parseManifest(await readFile(join(dir, MANIFEST_FILE), "utf-8"));
  const pkg = manifest.package;
  if (manifest.requires?.packages?.some((p) => p.package === pkg)) throw new Error(`bad_package: ${pkg} requires itself`);

  const problems: string[] = [];
  const items: PackageItem[] = [];
  const steps = new Map<string, PackageItem>();
  const claims: string[] = [];
  const apps = new Map<string, boolean>();
  const unknown = new Set<string>();
  for (const file of files) {
    const slash = file.indexOf("/");
    if (slash < 0) continue; // strut.yaml, a README, a LICENSE: in the digest, not items
    const top = file.slice(0, slash);
    const rest = file.slice(slash + 1);
    try {
      if (top === "workflows") {
        if (!rest.endsWith(".yaml")) throw new Error("a workflow is a .yaml file");
        items.push({ kind: "workflow", name: itemName(pkg, "workflow", rest.slice(0, -5)), path: file });
      } else if (top === "steps") {
        if (rest.endsWith(".claims.yaml")) claims.push(file);
        else if (rest.endsWith(".ts")) {
          const item: PackageItem = { kind: "step", name: itemName(pkg, "step", rest.slice(0, -3)), path: file };
          if (rest.split("/").pop()!.startsWith("_")) item.helper = true;
          steps.set(file.slice(0, -3), item);
          items.push(item);
        } else throw new Error("a step is a .ts file, its claims a .claims.yaml beside it");
      } else if (top === "concepts") {
        if (rest.includes("/") || !rest.endsWith(".md")) throw new Error("a Concept is a page, concepts/<Name>.md, with no folders");
        items.push({ kind: "concept", name: rest.slice(0, -3), path: file });
      } else if (top === "apps") {
        const at = rest.indexOf("/");
        if (at < 0) throw new Error("an app is a folder, apps/<name>/");
        const app = rest.slice(0, at);
        if (!apps.has(app)) {
          validateAppName(`${pkg}/${app}`);
          apps.set(app, false);
          items.push({ kind: "app", name: `${pkg}/${app}`, path: `apps/${app}` });
        }
        if (rest.slice(at + 1) === "app.yaml") apps.set(app, true);
      } else if (!unknown.has(top)) {
        unknown.add(top);
        problems.push(`${top}/ is not a folder this strut knows (workflows, steps, concepts, apps) — a package from a newer strut?`);
      }
    } catch (err) {
      problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const file of claims) {
    const step = steps.get(file.slice(0, -".claims.yaml".length));
    if (!step) problems.push(`${file}: claims belong beside the step they are about, ${file.replace(/\.claims\.yaml$/, ".ts")}`);
    else if (step.helper) problems.push(`${file}: a \`_\` file is a helper, not a step, so it has no claims`);
    else step.claims = file;
  }
  for (const [app, hasManifest] of apps) if (!hasManifest) problems.push(`apps/${app}/: an app's folder holds its app.yaml`);
  if (!problems.length && !items.length) problems.push("no items — a package holds at least one workflow, step, Concept or app");
  if (problems.length) throw new Error(`bad_package: ${problems.join("; ")}`);
  return { manifest, digest: `sha256:${await hashTree(dir, files)}`, files, items };
}
