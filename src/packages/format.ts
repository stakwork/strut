/**
 * A PACKAGE (plans/marketplace.md §1): a directory holding one namespace —
 * `strut.yaml`, a few hand-written lines, and the folders beside it, each
 * file an item named under the package's prefix:
 *
 *   workflows/<path>.yaml        → the workflow <package>/<path>
 *   steps/<path>.ts              → the step <package>/<path> (`_` files: helpers)
 *   steps/<path>.claims.yaml     → that step's claims
 *   concepts/<file>.md           → a Concept page, named by its `name`
 *   apps/<name>/                 → the app <package>/<name>, a directory with app.yaml
 *   graph/<Type>.yaml            → the graph type <Type> and its edges (./graph-types.ts)
 *
 * The manifest's `job:` names the steps the `job` workflow's agent may call
 * (plans/followed-repos.md §3; stadeum plans/software.md §5, item 16):
 * `tools`, and `approve`, the ones among them whose call is a proposal. A
 * name is the package's own step first, as every bare name in a package is
 * (src/package-lookup.ts): `claim` → `<package>/claim` when it ships
 * `steps/claim.ts`. A name it does not ship is STRUT's step of that type
 * (`git/push`), which the install holds to what a package may grant
 * (`strutGrantProblem`, src/job-seed.ts). A glob is over the package's own
 * steps alone (`*` → every step it has), so an older manifest reads as it
 * did, and strut's steps are named one by one. Another package's step is
 * never granted: a name of three segments or more is refused. The `job`
 * seed grants what each installed package names (src/job-seed.ts).
 *
 * Its `provides.secrets` names the secrets the package's steps MANAGE, each
 * one they may read (`requires.secrets` or `requires.optional`, else the
 * package is refused): `ctx.services.secrets.own` and, on an admin's call
 * from the package's own `admin: true` app, `.deployment` reach those names
 * and no other (src/packages/fence.ts).
 *
 * Its `provides.git` names the hosts a token it holds serves, each with the
 * secret that holds it (`{ host: github.com, secret: GITHUB_TOKEN }`), one
 * its steps may read: strut's git steps, `git+` sources and any step's
 * `secrets.git(url)` read the run's value of that secret for a repository
 * on that host, and send it nowhere else (src/git-hosts.ts). Its
 * `requires.git: true` says its own steps read that token themselves, for
 * any host the box serves (`secrets.git`); without it they never see one,
 * though strut's git steps they call still use it (src/packages/fence.ts).
 *
 * An entry may also name the FORGE'S STEPS for its host
 * (plans/package-seams.md §4): `repositories`, what the token reaches, and
 * `pull_request`, opening one — each the package's own step by its name
 * inside the package first, else strut's by its type (`github/create-pr`),
 * never another package's. `readPackage` resolves them to full types
 * (`gitHosts`); the install checks each exists; strut's `git/repositories`
 * and `git/pull-request` pick them by host.
 *
 * Its `schedules:` names workflows of the package strut runs on a schedule,
 * each an automation's draft (`name?`, `trigger`, `input?`) with the
 * `workflow` it runs, by its name inside the package. `readPackage`
 * resolves them over the package's OWN workflows and refuses one that is
 * not there, a trigger the automations' grammar does not have, and a
 * `once`; the packages' sync makes the automations (./schedules.ts). An
 * entry's `each: <SECRET>` runs it once for each person who holds that
 * secret as their own, as that person: one the package provides
 * (`provides.secrets`), else the package is refused.
 *
 * Its `maxRunCostUsd:` caps a run of one of its OWN workflows, by its name
 * inside the package, in dollars (`{ reply: 1 }`): the cap an admin sets
 * with `PUT /workflows/:name/run-cap`, shipped by the package. The install
 * records it on the version it writes (`upstream.maxRunCostUsd`), and an
 * admin's own cap wins over it (`workflowRunCap`, src/run-cap.ts).
 *
 * Its `on:` names workflows of the package strut runs when a node of a
 * type is created, updated or deleted (plans/package-seams.md §2): each
 * entry one op, one graph type and one of the package's OWN workflows, by
 * its name inside the package (`{ created: Workspace, workflow: setup }`).
 * `readPackage` resolves them and refuses a workflow the package does not
 * carry; strut matches them at each graph write it hears (./on.ts).
 *
 * A Concept page comes in two forms (plans/concept-history.md §2.1, read by
 * `parseConceptFile`, src/concept-seed.ts): the old `concepts/<Name>.md`,
 * named by its file, with a `description` and one `parent`; and the new
 * one, named by the `name` in its front matter under whatever file name it
 * has — a build writes `concepts/<key>.md`, the node key of the name — with
 * every attribute and every parent (`parents`). Two pages with one name are
 * refused.
 *
 * A package may be a BUNDLE instead (stadeum plans/software.md §3.3):
 * `bundle:` lists other packages by the `git+` branch each is followed at,
 * with no digest, and the bundle holds nothing else — no folder, and no
 * `requires`, `job`, `provides`, `schedules` or `maxRunCostUsd`. A subscription to it follows
 * each listed package as a part of its own (./subscriptions.ts); nothing
 * installs a bundle (`package_is_bundle`, ./install.ts). Each entry is a
 * `git+https://host/org/repo[@<branch>][#<folder>]` ref that names a branch
 * (a full commit sha is refused, as a subscription's `PUT` refuses one), one
 * repository folder once. Whether a listed package is itself a bundle is
 * only known once it is read, so its part says so then: a bundle lists
 * packages, never bundles. An older strut refuses the key (the manifest is
 * strict) instead of installing an empty package.
 *
 * Its DIGEST is the tree hash over every file in it, `strut.yaml` included
 * (`hashTree`, src/version.ts — an app's version hash is the same function
 * over its own directory, so an app's files are hashed alike in both). The
 * manifest holds nothing the files say: the items ARE the directory.
 *
 * `readPackage` reads one and refuses what it cannot install whole: an
 * unknown top-level folder (a package from a newer strut fails instead of
 * installing half), a file a folder does not hold, a name the prefix rule
 * does not allow, anything but a regular file, two Concept pages with one
 * name. Whether the code loads, the Concepts' parents resolve or an app
 * builds is the install's to check; this reads paths, the manifest and each
 * Concept page's front matter (for its name), and writes nothing.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { validateAppName } from "../apps/files.js";
import { checkInputTemplates, triggerSchema, type TriggerDraft } from "../automations.js";
import { globToRegExp } from "../closure.js";
import { FORGE_STEPS, GIT_HOST_RE, type GitHost } from "../git-hosts.js";
import { parseConceptFile } from "../concept-seed.js";
import { packagePrefixOf } from "../package-lookup.js";
import { hashTree } from "../version.js";
import { validateStepName, validateWorkflowName } from "../workspace.js";
import { loadYaml } from "../yaml.js";

export const MANIFEST_FILE = "strut.yaml";

/** A graph type's name: `graph/<Type>.yaml`. */
export const GRAPH_TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** `sha256:<64 hex>` — how a package is pinned. */
export const PACKAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A package name: `publisher/name`, lowercase, one slash — a convention,
 *  like a forge's `org/repo`, and the prefix every item is named under. */
export const PACKAGE_NAME = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

const packageName = z.string().regex(PACKAGE_NAME, "a package is named publisher/name: two lowercase segments, [a-z][a-z0-9-]*");
const names = z.array(z.string().min(1));

/** A schedule's `trigger`: the automations' grammar (`triggerSchema`,
 *  src/automations.ts), the one "how often" strut has. Held strict like the
 *  rest of the manifest — a key no shape has is refused, not dropped — and
 *  recurring: a release outlives a `once`. */
const scheduleTrigger = z.unknown().transform((raw, ctx): TriggerDraft => {
  const parsed = triggerSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
    return z.NEVER;
  }
  const extra = Object.keys(raw as object).filter((k) => !(k in parsed.data));
  if (extra.length) ctx.addIssue({ code: "custom", message: `Unrecognized key${extra.length > 1 ? "s" : ""}: ${extra.map((k) => JSON.stringify(k)).join(", ")}` });
  if (parsed.data.every === "once") ctx.addIssue({ code: "custom", path: ["every"], message: "a package's schedule recurs: interval, day, week or month" });
  return parsed.data;
});

/** The ops an `on:` entry names: what happened to the node. */
export const ON_OPS = ["created", "updated", "deleted"] as const;
export type OnOp = (typeof ON_OPS)[number];

const graphTypeName = z.string().regex(GRAPH_TYPE_NAME, "a graph type is a letter then letters, digits or _ (Workspace)");

/** One `on:` entry: exactly one op naming a type, and the workflow. */
const onEntry = z
  .object({
    created: graphTypeName.optional(),
    updated: graphTypeName.optional(),
    deleted: graphTypeName.optional(),
    workflow: z.string().min(1),
  })
  .strict()
  .superRefine((e, ctx) => {
    const ops = ON_OPS.filter((op) => e[op] !== undefined);
    if (ops.length !== 1) ctx.addIssue({ code: "custom", message: `an entry names one op — created, updated or deleted — and its type${ops.length ? `, not ${ops.join(" and ")}` : ""}` });
  });

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
        // Secrets its steps may read but can do without, such as a person's
        // own token (plans/followed-repos.md §2): the fence lets a step read
        // them, and neither the gate nor an install's `missing` asks for them.
        optional: names.optional(),
        binaries: names.optional(),
        runtimes: z.array(z.object({ name: z.string().min(1), image: z.string().optional(), binaries: names.optional() }).strict()).optional(),
        packages: z
          .array(z.object({ package: packageName, digest: z.string().regex(PACKAGE_DIGEST, "a digest is sha256:<64 hex>"), source: z.string().min(1) }).strict())
          .optional(),
        // Its steps read the run's token for a repository's host themselves
        // (`secrets.git(url)`), to hand git where strut does not run it (a
        // pod). Shown at install; without it a step never sees a token.
        git: z.literal(true, { message: "requires.git is true or left out" }).optional(),
      })
      .strict()
      .optional(),
    // The steps the job agent may call — the package's own, and strut's
    // named one by one — and among them the ones that ask first
    // (plans/followed-repos.md §3). Strict like the rest, so an older strut
    // refuses the package instead of installing it without the tools it is
    // for.
    job: z
      .object({ tools: z.array(z.string().min(1)).min(1, "job.tools names at least one step"), approve: names.optional() })
      .strict()
      .optional(),
    // What the package PROVIDES to the server. `secrets`: the ones its steps
    // manage (src/packages/fence.ts) — read a person's own value apart from
    // the deployment's, set and delete it, and on an admin's call from the
    // package's own `admin: true` app the deployment's too. `git`: the hosts
    // a token it holds serves, each with its secret (src/git-hosts.ts). Each
    // secret is one its steps may read (`requires`). Strict like the rest: a
    // strut from before a key refuses the package instead of installing it
    // without it.
    provides: z
      .object({
        secrets: names.optional(),
        git: z
          .array(
            z
              .object({
                host: z.string().regex(GIT_HOST_RE, "a host is a lowercase hostname, with :port when it is not the default (github.com, git.acme.com:3000)"),
                secret: z.string().min(1),
                // The forge's steps for this host (plans/package-seams.md §4):
                // the package's own by <name>, else strut's by its type.
                repositories: z.string().min(1).optional(),
                pull_request: z.string().min(1).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    // The package's own workflows strut runs on a schedule: an automation
    // each, made at install, followed at each release, dropped at uninstall
    // (src/packages/schedules.ts). An entry is an automation's draft — the
    // `name`, `trigger` and `input` of `POST /workflows/:name/automations`,
    // and of strut's own `automation.json` — with the `workflow` it runs.
    // Strict like the rest: an older strut refuses the package instead of
    // installing it without its schedules.
    schedules: z
      .array(
        z
          .object({
            workflow: z.string().min(1),
            name: z.string().trim().min(1).optional(),
            trigger: scheduleTrigger,
            input: z.record(z.string(), z.unknown()).optional(),
            // Run once for each person who holds this secret as their own,
            // as them: one the package provides (`provides.secrets`).
            each: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    // The most a run of one of the package's own workflows may spend, in
    // dollars, by its name inside the package: a workflow's
    // `maxRunCostUsd` (src/run-cap.ts), recorded on the version the install
    // writes. Strict like the rest: an older strut refuses the package
    // instead of running it under the box's default cap.
    maxRunCostUsd: z
      .record(z.string().min(1), z.number().finite().positive("a run's cap is a positive number of dollars"))
      .optional(),
    // The package's own workflows strut runs when a node of a type is
    // created, updated or deleted (plans/package-seams.md §2, ./on.ts): one
    // op, one type, one workflow an entry. Strict like the rest: an older
    // strut refuses the package instead of installing it without them.
    on: z.array(onEntry).optional(),
    // The packages a bundle lists, each by the `git+` branch it is followed
    // at (./subscriptions.ts). A bundle holds nothing else (`readPackage`).
    bundle: z.array(z.string().min(1)).min(1, "a bundle lists at least one package").optional(),
  })
  .strict();

export type PackageManifest = z.infer<typeof manifestSchema>;

/** What a bundle may not carry: what belongs to a package's own items. */
const NOT_IN_A_BUNDLE = ["requires", "job", "provides", "schedules", "maxRunCostUsd", "on"] as const;

/** Every secret a package's steps may read: `requires.secrets` and
 *  `requires.optional` — its fence. */
export function readableSecrets(manifest: Pick<PackageManifest, "requires">): string[] {
  return [...new Set([...(manifest.requires?.secrets ?? []), ...(manifest.requires?.optional ?? [])])];
}

/** One item: what the install publishes. A workflow, step or app is named
 *  `<package>/<path>`; a Concept by its page's name — the new form's `name`,
 *  the old form's file — (its stamp carries the package, `seedConcepts`); a graph type by its type name, since a type is
 *  the graph's, not the package's. `path` is the file, or the app's directory. */
export interface PackageItem {
  kind: "workflow" | "step" | "concept" | "app" | "type";
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
  /** The manifest's `job:`, resolved: full types — the package's own steps
   *  and strut's (`strutGrants`) — deduplicated and sorted. */
  job?: JobGrant;
  /** The manifest's `schedules:`, each on a workflow of the package. */
  schedules?: PackageSchedule[];
  /** The manifest's `maxRunCostUsd:`, by the workflow's full name. */
  maxRunCostUsd?: Record<string, number>;
  /** The manifest's `on:`, each on a workflow of the package. */
  on?: PackageTrigger[];
  /** The manifest's `provides.git`, each forge step resolved to its full
   *  type: the package's own (`<package>/<name>`) or strut's. */
  gitHosts?: GitHost[];
}

/** A workflow of the package strut runs when a node of `type` is `op`
 *  (plans/package-seams.md §2): on the workflow's full name. */
export interface PackageTrigger {
  op: OnOp;
  type: string;
  workflow: string;
}

/** A workflow of the package strut runs on a schedule: an automation's
 *  draft, named for the package (its `name` unique in it, the workflow's
 *  name inside the package unless given), on the workflow's full name. */
export interface PackageSchedule {
  name: string;
  workflow: string;
  trigger: TriggerDraft;
  input: Record<string, unknown>;
  /** Run once for each person who holds this secret as their own, as them. */
  each?: string;
}

/** What a package gives the `job` workflow's agent: step types — the
 *  package's own (`<package>/<name>`) and strut's (`git/push`) — and the
 *  ones among them whose call becomes a proposal. */
export interface JobGrant {
  tools: string[];
  approve: string[];
}

/** The types among a package's grant that are strut's steps, not its own:
 *  the ones not under its prefix. */
export const strutGrants = (pkg: string, types: readonly string[]): string[] => types.filter((t) => !t.startsWith(`${pkg}/`));

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
  if (manifest.bundle) return readBundle(dir, files, manifest as PackageManifest & { bundle: string[] });
  const pkg = manifest.package;
  if (manifest.requires?.packages?.some((p) => p.package === pkg)) throw new Error(`bad_package: ${pkg} requires itself`);

  const problems: string[] = [];
  const items: PackageItem[] = [];
  const steps = new Map<string, PackageItem>();
  const claims: string[] = [];
  const apps = new Map<string, boolean>();
  const pages = new Map<string, string>(); // a Concept's name → its file
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
        if (rest.includes("/") || !rest.endsWith(".md")) throw new Error("a Concept is a page, concepts/<file>.md, with no folders");
        const { name } = parseConceptFile(rest, await readFile(join(dir, file), "utf-8"), "");
        const other = pages.get(name);
        if (other !== undefined) throw new Error(`the Concept ${name} is concepts/${other} too — a page's name is its identity, one page each`);
        pages.set(name, rest);
        items.push({ kind: "concept", name, path: file });
      } else if (top === "graph") {
        if (rest.includes("/") || !rest.endsWith(".yaml") || !GRAPH_TYPE_NAME.test(rest.slice(0, -5))) {
          throw new Error("a graph type is graph/<Type>.yaml, the type's name a letter then letters, digits or _, with no folders");
        }
        items.push({ kind: "type", name: rest.slice(0, -5), path: file });
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
        problems.push(`${top}/ is not a folder this strut server knows (workflows, steps, concepts, apps, graph) — a package from a newer strut release?`);
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
  if (!problems.length && !items.length) problems.push("no items — a package holds at least one workflow, step, Concept, app or graph type");
  const job = manifest.job ? jobGrant(pkg, manifest.job, items, problems) : undefined;
  const readable = readableSecrets(manifest);
  for (const name of manifest.provides?.secrets ?? []) {
    if (!readable.includes(name)) problems.push(`${MANIFEST_FILE}: provides.secrets: ${name} is not in requires.secrets or requires.optional — a package's steps manage only secrets they may read`);
  }
  const hosts = new Set<string>();
  const ownSteps = new Set(items.filter((i) => i.kind === "step" && !i.helper).map((i) => i.name));
  const gitHosts = (manifest.provides?.git ?? []).map((entry, i): GitHost => {
    const { host, secret } = entry;
    if (!readable.includes(secret)) problems.push(`${MANIFEST_FILE}: provides.git: ${secret} (for ${host}) is not in requires.secrets or requires.optional — a package provides only a token its steps may read`);
    if (hosts.has(host)) problems.push(`${MANIFEST_FILE}: provides.git names ${host} twice — a host is served by one secret`);
    hosts.add(host);
    const out: GitHost = { host, secret };
    for (const field of FORGE_STEPS) {
      const name = entry[field];
      if (!name) continue;
      const own = `${pkg}/${name}`;
      if (ownSteps.has(own)) out[field] = own;
      else if (packagePrefixOf(name)) problems.push(`${MANIFEST_FILE}: provides.git[${i}].${field}: ${JSON.stringify(name)} is another package's step, or this one's by its full type — name the package's own step by <name> (steps/<name>.ts) or strut's by its type (github/create-pr)`);
      else {
        try {
          validateStepName(name);
          out[field] = name;
        } catch (err) {
          problems.push(`${MANIFEST_FILE}: provides.git[${i}].${field}: ${JSON.stringify(name)} is not a step's name — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return out;
  });
  const schedules = manifest.schedules ? resolveSchedules(pkg, manifest.schedules, items, manifest.provides?.secrets ?? [], problems) : undefined;
  const on = manifest.on ? resolveOn(pkg, manifest.on, items, problems) : undefined;
  const caps = manifest.maxRunCostUsd ? resolveCaps(pkg, manifest.maxRunCostUsd, items, problems) : undefined;
  if (problems.length) throw new Error(`bad_package: ${problems.join("; ")}`);
  return {
    manifest,
    digest: `sha256:${await hashTree(dir, files)}`,
    files,
    items,
    ...(job ? { job } : {}),
    ...(schedules ? { schedules } : {}),
    ...(caps ? { maxRunCostUsd: caps } : {}),
    ...(on ? { on } : {}),
    ...(gitHosts.length ? { gitHosts } : {}),
  };
}

/** A bundle: its list, each entry a branch to follow and a repository
 *  folder named once, and nothing of its own — no folder, no `requires`,
 *  `job`, `provides` or `schedules` (a file at the top, a README, is fine). */
async function readBundle(dir: string, files: string[], manifest: PackageManifest & { bundle: string[] }): Promise<PackageInfo> {
  // Lazily: git-source.ts reads this module, and only a bundle needs it.
  const { branchRefProblem, parseGitRef, refSource } = await import("./git-source.js");
  const problems: string[] = [];
  for (const key of NOT_IN_A_BUNDLE) {
    if (manifest[key] !== undefined) problems.push(`${MANIFEST_FILE}: ${key}: a bundle lists packages and has no ${key} of its own — it belongs to a package the bundle lists`);
  }
  for (const top of new Set(files.filter((f) => f.includes("/")).map((f) => f.slice(0, f.indexOf("/"))))) {
    problems.push(`${top}/: a bundle lists packages and holds no items of its own — put them in a package the bundle lists`);
  }
  const seen = new Map<string, number>();
  manifest.bundle.forEach((ref, i) => {
    const problem = branchRefProblem(ref);
    if (problem) return problems.push(`${MANIFEST_FILE}: bundle[${i}]: ${problem.replace(/^ref /, "")}`);
    const source = refSource(parseGitRef(ref) as Exclude<ReturnType<typeof parseGitRef>, string>);
    const at = seen.get(source);
    if (at !== undefined) problems.push(`${MANIFEST_FILE}: bundle[${i}]: ${ref} reads the folder bundle[${at}] reads — a bundle lists a package once, at one branch`);
    seen.set(source, i);
  });
  if (problems.length) throw new Error(`bad_package: ${problems.join("; ")}`);
  return { manifest, digest: `sha256:${await hashTree(dir, files)}`, files, items: [] };
}

/** The manifest's `schedules:` over the package's own workflows: each names
 *  one by its name inside the package, so a package never schedules
 *  strut's workflows or another package's. Two with one name, an input
 *  template that reads anything but `now`, `today` and `last`, and an
 *  `each` the package does not provide are problems. */
function resolveSchedules(pkg: string, entries: NonNullable<PackageManifest["schedules"]>, items: PackageItem[], provided: string[], problems: string[]): PackageSchedule[] {
  const own = new Set(items.filter((i) => i.kind === "workflow").map((i) => i.name));
  const named = new Set<string>();
  return entries.map((e, i) => {
    const at = `${MANIFEST_FILE}: schedules[${i}]`;
    if (!own.has(`${pkg}/${e.workflow}`)) {
      problems.push(`${at}.workflow: ${JSON.stringify(e.workflow)} is not a workflow of the package — a schedule names one of the package's own workflows (workflows/<name>.yaml) by <name>`);
    }
    const name = e.name ?? e.workflow;
    if (named.has(name)) problems.push(`${at}.name: two schedules are named ${JSON.stringify(name)} — a schedule's name, its workflow's unless given, is its identity in the package`);
    named.add(name);
    for (const p of checkInputTemplates(e.input ?? {})) problems.push(`${at}.input: ${p}`);
    if (e.each !== undefined && !provided.includes(e.each)) {
      problems.push(`${at}.each: ${e.each} is not in provides.secrets — a schedule runs for each person who holds a secret the package provides`);
    }
    return { name, workflow: `${pkg}/${e.workflow}`, trigger: e.trigger, input: e.input ?? {}, ...(e.each !== undefined ? { each: e.each } : {}) };
  });
}

/** The manifest's `maxRunCostUsd:` over the package's own workflows, each
 *  by its name inside the package, so a package never caps strut's
 *  workflows or another package's. By the workflow's full name. */
function resolveCaps(pkg: string, caps: Record<string, number>, items: PackageItem[], problems: string[]): Record<string, number> {
  const own = new Set(items.filter((i) => i.kind === "workflow").map((i) => i.name));
  const out: Record<string, number> = {};
  for (const [name, usd] of Object.entries(caps)) {
    if (own.has(`${pkg}/${name}`)) out[`${pkg}/${name}`] = usd;
    else problems.push(`${MANIFEST_FILE}: maxRunCostUsd.${name}: ${JSON.stringify(name)} is not a workflow of the package — a cap names one of the package's own workflows (workflows/<name>.yaml) by <name>`);
  }
  return out;
}

/** The manifest's `on:` over the package's own workflows: each names one
 *  by its name inside the package, so a write never runs strut's workflow
 *  or another package's. The same entry twice is a problem. */
function resolveOn(pkg: string, entries: NonNullable<PackageManifest["on"]>, items: PackageItem[], problems: string[]): PackageTrigger[] {
  const own = new Set(items.filter((i) => i.kind === "workflow").map((i) => i.name));
  const seen = new Set<string>();
  return entries.map((e, i) => {
    const op = ON_OPS.find((o) => e[o] !== undefined)!;
    const type = e[op]!;
    const at = `${MANIFEST_FILE}: on[${i}]`;
    if (!own.has(`${pkg}/${e.workflow}`)) {
      problems.push(`${at}.workflow: ${JSON.stringify(e.workflow)} is not a workflow of the package — an entry names one of the package's own workflows (workflows/<name>.yaml) by <name>`);
    }
    const key = `${op} ${type} ${e.workflow}`;
    if (seen.has(key)) problems.push(`${at}: ${op}: ${type} runs ${e.workflow} twice`);
    seen.add(key);
    return { op, type, workflow: `${pkg}/${e.workflow}` };
  });
}

/** The manifest's `job:`: a name is the package's own step first (helpers
 *  are not steps), else strut's step of that type, which this reads only
 *  for its form — whether this strut has it, and may hand it out, is the
 *  install's (`strutGrantProblem`). A glob is matched against the
 *  package's own steps alone, and one that matches none is a problem; so
 *  are a helper, a name of three segments or more (another package's
 *  step, or this one's by its full type) and an `approve` step that is not
 *  among the tools. */
function jobGrant(pkg: string, job: NonNullable<PackageManifest["job"]>, items: PackageItem[], problems: string[]): JobGrant {
  const steps = items.filter((i) => i.kind === "step");
  const own = steps.filter((i) => !i.helper).map((i) => i.name.slice(pkg.length + 1));
  const helpers = new Set(steps.filter((i) => i.helper).map((i) => i.name.slice(pkg.length + 1)));
  const resolve = (field: string, names: string[]): string[] => {
    const out = new Set<string>();
    const problem = (name: string, why: string) => problems.push(`${MANIFEST_FILE}: job.${field}: ${JSON.stringify(name)} ${why}`);
    for (const name of names) {
      if (name.includes("*")) {
        const re = globToRegExp(name);
        const hit = own.filter((s) => re.test(s));
        if (!hit.length) problem(name, "matches no step of the package — a glob is over the package's own steps (steps/<name>.ts); strut's steps are named one by one");
        for (const s of hit) out.add(`${pkg}/${s}`);
      } else if (own.includes(name)) out.add(`${pkg}/${name}`);
      else if (helpers.has(name)) problem(name, "is a helper (a `_` file), not a step");
      else if (packagePrefixOf(name)) problem(name, "is another package's step, or this one's by its full type — a grant names the package's own steps by <name> (steps/<name>.ts) and strut's by their type (git/push), never another package's");
      else {
        try {
          validateStepName(name);
          out.add(name);
        } catch (err) {
          problem(name, `is not a step's name — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return [...out].sort();
  };
  const tools = resolve("tools", job.tools);
  const approve = resolve("approve", job.approve ?? []);
  for (const t of approve) if (!tools.includes(t)) problems.push(`${MANIFEST_FILE}: job.approve: ${t} is not among job.tools — approve names the granted steps whose call asks first`);
  return { tools, approve };
}
