/**
 * SERVE MODE (plans/app-repos.md §2.1, §4; work item 1): a normal strut
 * started with `STRUT_SERVE=<ref>` is the box one package's app is served
 * from. It installs the ref through the distro's door, applies the
 * package's `serve.yaml` to its public view, and answers `/` with the app
 * alone (createStrut, web/src/page.ts). Everything else stays behind the key.
 *
 * `serve.yaml` is a top-level file of the package — in the digest, read past
 * by `readPackage` like a README — saying which app `/` shows and what a
 * visitor may call and run:
 *
 *   app: game                       # apps/game
 *   title: Moon Lander              # <title>, og:title (default: the app's title)
 *   description: Land softly.       # og:description (default: the app's)
 *   image: apps/game/public/og.png  # og:image, an image file in the package
 *   reads: [score-board]            # the app's public reads (step types)
 *   runnable: [{ kind: workflow, name: ghost, dailyCapUsd: 5 }]
 *   concepts: [Moon Lander]         # Concept roots in the public view
 *
 * Names are the package's own, resolved package-first (src/package-lookup.ts)
 * against what the package holds and written whole into the record
 * (`acme/moonlander/ghost`). The record is checked as a person's
 * `PUT /public-view` is (`surfaceProblem`, then `runnableProblems` through
 * the caller), and is the box's whole public view: that route is refused on
 * a served box. A field this strut does not know is refused, so a
 * `serve.yaml` from a newer strut fails the deploy instead of half applying.
 *
 * A DEPLOY resolves the ref into the package cache, reads `serve.yaml` and
 * resolves its names (a bad file stops here, before anything is written),
 * installs the package through the distro's door, holds the app at the
 * version just installed, and writes the public view. A deploy that cannot
 * resolve, install or apply leaves the previous one serving and says why
 * (`GET /serve`); the state is kept in `<dataDir>/serve.json`. A ref is
 * FOLLOWED as a subscription is (src/packages/subscriptions.ts): read again
 * at the subscriptions' poll and on the publisher's ping, deployed when its
 * digest moved. One deploy at a time.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { AppsCapability } from "../apps/apps.js";
import { defaultKitDir, type KitLocation } from "../apps/kit.js";
import { nameInPackage } from "../package-lookup.js";
import { normalizeSurface, runnableShapeProblem, surfaceProblem, type PublicRunnable, type PublicSurface } from "../public-surface.js";
import type { WorkspaceStore } from "../workspace.js";
import { loadYaml } from "../yaml.js";
import { bootPackageProblem } from "./boot.js";
import { resolvePackage, type CachedPackage, type PackageCache } from "./cache.js";
import { PACKAGE_NAME, type PackageInfo } from "./format.js";
import type { InstallResult } from "./install.js";
import { parsePkRef } from "./pk.js";

export const SERVE_FILE = "serve.yaml";
/** Where a served box keeps what it serves, beside `public.json`. */
export const SERVE_STATE_FILE = "serve.json";

/** What `STRUT_SERVE` (+ `STRUT_SERVE_URL`) and `createStrut({ serve })` name. */
export interface ServeRef {
  /** `publisher/name` (through the followed indexes), `pk:<key>/<publisher>/<name>` with `url`, or `file:/path`. */
  ref: string;
  /** A `pk:` ref's catalog: the publisher's `…/packages/catalog?public=1`. */
  url?: string;
}

/** The ref from the options, else the environment; undefined when neither
 *  names one. A bad ref throws, so it fails the boot. */
export function serveRefOf(opt: ServeRef | false | undefined, env: Record<string, string | undefined>): ServeRef | undefined {
  if (opt === false) return undefined;
  const raw = opt ?? (env["STRUT_SERVE"]?.trim() ? { ref: env["STRUT_SERVE"].trim(), ...(env["STRUT_SERVE_URL"]?.trim() ? { url: env["STRUT_SERVE_URL"].trim() } : {}) } : undefined);
  if (!raw) return undefined;
  const label = opt ? "serve" : "STRUT_SERVE";
  if (raw.ref.startsWith("git+")) throw new Error(`${label}: ${raw.ref}: git+ refs are not served yet — a package name, pk: with a catalog URL, or file:/path`);
  const problem = bootPackageProblem({ ref: raw.ref, ...(raw.url !== undefined ? { url: raw.url } : {}) });
  if (problem) throw new Error(`${label}: ${problem.replace(/\burl\b/g, opt ? "url" : "STRUT_SERVE_URL")}`);
  return { ref: raw.ref, ...(raw.url ? { url: raw.url } : {}) };
}

// ── serve.yaml ───────────────────────────────────────────────────────────

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const text = (field: string, max: number) => z.string().trim().min(1, `${field} is not empty`).max(max, `${field} is at most ${max} characters`);
const names = z.array(z.string().min(1));

const serveSchema = z
  .object({
    app: text("app", 200),
    title: text("title", 200).optional(),
    description: text("description", 1000).optional(),
    image: z.string().regex(IMAGE, "image is an image file in the package (.png, .jpg, .gif, .webp, .svg)").optional(),
    reads: names.optional(),
    runnable: z.array(z.unknown()).optional(),
    concepts: names.optional(),
  })
  .strict();

export type ServeFile = Omit<z.infer<typeof serveSchema>, "runnable"> & { runnable?: PublicRunnable[] };

const LATER_FIELDS = new Set(["signIn", "visitorKey", "limits"]);

/** `serve.yaml`'s text → its fields, or a thrown `serve_invalid: …`
 *  naming every problem. */
export function parseServeFile(source: string): ServeFile {
  let raw: unknown;
  try {
    raw = loadYaml(source);
  } catch (err) {
    throw new Error(`serve_invalid: ${SERVE_FILE} is not valid YAML — ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = serveSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      if (i.code === "unrecognized_keys") {
        const keys = (i as { keys: string[] }).keys;
        const later = keys.filter((k) => LATER_FIELDS.has(k));
        return later.length === keys.length
          ? `${later.join(", ")}: not on this strut server yet (signed-in visitors come later)`
          : `unknown field${keys.length > 1 ? "s" : ""} ${keys.join(", ")} — ${SERVE_FILE} is { app, title?, description?, image?, reads?, runnable?, concepts? }`;
      }
      const path = i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "");
      return `${path ? `${path}: ` : ""}${i.message}`;
    });
    throw new Error(`serve_invalid: ${SERVE_FILE}: ${issues.join("; ")}`);
  }
  const problems: string[] = [];
  for (const item of parsed.data.runnable ?? []) {
    const bad = runnableShapeProblem(item);
    if (bad) problems.push(`runnable: ${bad}`);
  }
  if (problems.length) throw new Error(`serve_invalid: ${SERVE_FILE}: ${problems.join("; ")}`);
  return parsed.data as ServeFile;
}

/** What a deploy applies: the public view record, and the page `/` is. */
export interface ServePlan {
  /** The app `/` shows, named whole. */
  app: string;
  title?: string;
  description?: string;
  /** The image's path in the package. */
  image?: string;
  surface: PublicSurface;
}

/** `serve.yaml`'s names resolved package-first against what `info` holds,
 *  as the public view record they write. Throws `serve_invalid: …`. */
export function planServe(file: ServeFile, info: Pick<PackageInfo, "manifest" | "items" | "files">): ServePlan {
  const pkg = info.manifest.package;
  const ofKind = (kind: "workflow" | "step" | "app") => new Set(info.items.filter((i) => i.kind === kind && !i.helper).map((i) => i.name));
  const apps = ofKind("app");
  const workflows = ofKind("workflow");
  const steps = ofKind("step");
  const problems: string[] = [];
  const app = nameInPackage(pkg, file.app, (n) => apps.has(n));
  if (!apps.has(app)) {
    const listed = [...apps].map((a) => a.slice(pkg.length + 1));
    problems.push(`app: "${file.app}" is not an app of ${pkg} (${listed.length ? `it holds ${listed.join(", ")}` : "it holds no app"} — apps/<name>/)`);
  }
  if (file.image !== undefined && !info.files.includes(file.image)) problems.push(`image: ${file.image} is not a file in the package`);
  if (problems.length) throw new Error(`serve_invalid: ${SERVE_FILE}: ${problems.join("; ")}`);
  const record = {
    concepts: file.concepts ?? [],
    apps: [{ name: app, ...(file.reads?.length ? { reads: file.reads.map((r) => nameInPackage(pkg, r, (n) => steps.has(n))) } : {}) }],
    runnable: (file.runnable ?? []).map((r) => ({ ...r, name: nameInPackage(pkg, r.name, (n) => (r.kind === "workflow" ? workflows : steps).has(n)) })),
  };
  const bad = surfaceProblem(record);
  if (bad) throw new Error(`serve_invalid: ${SERVE_FILE}: ${bad}`);
  return {
    app,
    ...(file.title ? { title: file.title } : {}),
    ...(file.description ? { description: file.description } : {}),
    ...(file.image ? { image: file.image } : {}),
    surface: normalizeSurface(record),
  };
}

/** A cached package's `serve.yaml`, parsed and planned. */
export async function readServePlan(info: CachedPackage): Promise<ServePlan> {
  if (!info.files.includes(SERVE_FILE)) throw new Error(`serve_invalid: ${info.manifest.package} has no ${SERVE_FILE} at its top — the file that says which app / shows`);
  return planServe(parseServeFile(await readFile(join(info.dir, SERVE_FILE), "utf-8")), info);
}

// ── The page `/` is ──────────────────────────────────────────────────────

/** What `GET /` is served with on a served box. */
export interface ServePage {
  app: string;
  title: string;
  description?: string;
  /** An image to show as og:image (served at `SERVE_IMAGE_PATH`). */
  image?: boolean;
  /** The app's icon as an SVG document, for the favicon. */
  icon?: string;
}

/** Where a served box answers its `serve.yaml` image, open to anyone. */
export const SERVE_IMAGE_PATH = "/serve/image";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The UI's `index.html` as a served box answers `/`: the meta `pickPage`
 * reads (`strut-serve`, the app's name — empty while nothing is deployed),
 * the title, the app's icon as the favicon, and the `og:` tags. `base` is the
 * absolute origin `og:image` and `og:url` are written against.
 */
export function servedHtml(html: string, page: ServePage | null, base: string): string {
  const meta: string[] = [`<meta name="strut-serve" content="${escapeHtml(page?.app ?? "")}" />`];
  let out = html;
  if (page) {
    const title = escapeHtml(page.title);
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
    if (page.icon) out = out.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(page.icon)}" />`);
    meta.push(`<meta property="og:type" content="website" />`, `<meta property="og:title" content="${title}" />`, `<meta property="og:url" content="${escapeHtml(`${base}/`)}" />`);
    if (page.description) {
      const d = escapeHtml(page.description);
      meta.push(`<meta name="description" content="${d}" />`, `<meta property="og:description" content="${d}" />`);
    }
    if (page.image) meta.push(`<meta property="og:image" content="${escapeHtml(`${base}${SERVE_IMAGE_PATH}`)}" />`, `<meta name="twitter:card" content="summary_large_image" />`);
  }
  return out.replace(/<head>/i, `<head>\n    ${meta.join("\n    ")}`);
}

/** The vendor layer's lucide icons folder, where the kit has one. */
function lucideIconsDir(kit: KitLocation): string | undefined {
  const vendorDir = kit.vendorDir ?? join(kit.dir ?? defaultKitDir(), "vendor");
  try {
    const { imports } = JSON.parse(readFileSync(join(vendorDir, "import-map.json"), "utf8")) as { imports: Record<string, string> };
    const entry = imports["lucide-react"];
    return entry ? join(dirname(resolve(vendorDir, entry)), "icons") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An app's manifest `icon` (a lucide name, `hand`) as a standalone SVG for a
 * favicon, read from the kit's copy of lucide — the icon the app's own build
 * draws. Black on a light tab, white on a dark one. Undefined when the kit
 * holds no such icon.
 */
export function lucideIconSvg(kit: KitLocation, name: string): string | undefined {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return undefined;
  const dir = lucideIconsDir(kit);
  if (!dir) return undefined;
  let source: string;
  try {
    source = readFileSync(join(dir, `${name}.mjs`), "utf8");
  } catch {
    return undefined;
  }
  const at = source.indexOf("node:");
  if (at < 0) return undefined;
  const parts: string[] = [];
  for (const m of source.slice(at).matchAll(/\[\s*"([a-z]+)",\s*\{([^}]*)\}\s*\]/g)) {
    const attrs = [...m[2]!.matchAll(/([a-zA-Z][\w-]*):\s*"([^"]*)"/g)].filter((a) => a[1] !== "key").map((a) => `${a[1]}="${escapeHtml(a[2]!)}"`);
    parts.push(`<${m[1]} ${attrs.join(" ")}/>`);
  }
  if (!parts.length) return undefined;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<style>svg{color:#111}@media (prefers-color-scheme:dark){svg{color:#eee}}</style>${parts.join("")}</svg>`
  );
}

// ── Deploys ──────────────────────────────────────────────────────────────

/** What is serving, kept in `serve.json`. */
export interface Serving {
  package: string;
  version: string;
  digest: string;
  /** The ref it was deployed from. */
  ref: string;
  /** The app `/` shows and the version the public view holds. */
  app: string;
  appVersion: string;
  /** When it was deployed. */
  at: string;
  page: ServePage;
  /** The image's path in the package, when `serve.yaml` names one. */
  image?: string;
}

export interface ServeState {
  serving?: Serving;
  /** The last time the ref was read. */
  fetchedAt?: string;
  /** What stopped the last deploy, and when; cleared by the next one that serves. */
  error?: string;
  errorAt?: string;
  /** The digest that deploy was of, when it got as far as reading the ref. */
  errorDigest?: string;
}

/** `GET /serve`. */
export interface ServeStatus extends ServeState {
  ref: string;
  url?: string;
  deploying: boolean;
}

export interface SyncOutcome {
  /** `deployed`: a new digest is serving; `current`: nothing moved; `error`: see `error`. */
  status: "deployed" | "current" | "error";
  digest?: string;
  error?: string;
}

export interface ServeDeps {
  serve: ServeRef;
  dataDir: string;
  cache: PackageCache;
  /** A bare name → its `pk:` ref and the catalog URLs to try, in order (the followed indexes). */
  resolveName(name: string): Promise<{ ref: string; urls: string[] }>;
  /** One install through the distro's door. */
  install(ref: string, opts: { url?: string; digest: string }): Promise<InstallResult>;
  apps: Pick<AppsCapability, "get" | "releases" | "promote">;
  workspace: Pick<WorkspaceStore, "getApp">;
  /** Why the record may not be the public view (`runnableProblems`), [] when it may. */
  surfaceProblems(s: PublicSurface): Promise<string[]>;
  setSurface(s: PublicSurface): Promise<void>;
  /** The app's icon as an SVG, for the favicon. */
  icon?(name: string): string | undefined;
  fetch?: typeof fetch;
  log?(line: string): void;
  warn?(line: string): void;
}

export interface ServeService {
  readonly ref: ServeRef;
  /** The deploy state, read at creation from `serve.json`. */
  status(): ServeStatus;
  /** What `/` is now: null while nothing has deployed. */
  page(): ServePage | null;
  /** The image `serve.yaml` names, as a file in the serving package; undefined without one. */
  imageFile(): string | undefined;
  /** Read the ref and deploy it when it moved. One at a time: a call while
   *  one runs is answered by one more run after it. Never throws. */
  sync(): Promise<SyncOutcome>;
  /** The publisher's ping names a key: is it this ref's? */
  follows(key?: string): boolean;
}

export async function createServe(deps: ServeDeps): Promise<ServeService> {
  const file = join(deps.dataDir, SERVE_STATE_FILE);
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  let state: ServeState = {};
  try {
    state = JSON.parse(await readFile(file, "utf8")) as ServeState;
  } catch (err: any) {
    if (err?.code !== "ENOENT") warn(`[serve] ${file} does not read, so nothing is serving until the next deploy: ${err instanceof Error ? err.message : String(err)}`);
  }
  let deploying = false;
  const save = async () => {
    await mkdir(deps.dataDir, { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, file);
  };

  // The publisher key the ref is read under: a `pk:` ref's own, a name's
  // once the index named it. A `file:` ref has none: no publisher pings it.
  const pk = deps.serve.ref.startsWith("pk:") ? parsePkRef(deps.serve.ref) : undefined;
  let followedKey = typeof pk === "object" ? pk.key : undefined;
  const byName = PACKAGE_NAME.test(deps.serve.ref);

  /** The ref into the cache: its directory and what the install takes. */
  const fetchRef = async (): Promise<{ info: CachedPackage; ref: string; url?: string }> => {
    const { ref, url } = deps.serve;
    const opts = { cache: deps.cache, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
    if (!PACKAGE_NAME.test(ref)) return { info: await resolvePackage(ref, { ...opts, ...(url ? { url } : {}) }), ref, ...(url ? { url } : {}) };
    const named = await deps.resolveName(ref);
    const parsed = parsePkRef(named.ref);
    if (typeof parsed === "object") followedKey = parsed.key;
    let last: unknown;
    for (const u of named.urls) {
      try {
        return { info: await resolvePackage(named.ref, { ...opts, url: u }), ref: named.ref, url: u };
      } catch (err) {
        last = err;
        // Only a host that did not answer moves on to the row's next URL.
        if (!(err instanceof Error && err.message.startsWith("package_fetch_failed:"))) throw err;
      }
    }
    throw last ?? new Error(`package_not_listed: no index this strut server follows lists ${ref}`);
  };

  const deploy = async (): Promise<SyncOutcome> => {
    const at = new Date().toISOString();
    let digest: string | undefined;
    try {
      const { info, ref, url } = await fetchRef();
      digest = info.digest;
      state.fetchedAt = at;
      if (state.serving?.digest === info.digest) {
        const { error: _e, errorAt: _a, errorDigest: _d, ...kept } = state;
        state = kept;
        await save();
        return { status: "current", digest };
      }
      // A bad serve.yaml stops here, before anything is written.
      const plan = await readServePlan(info);
      const result = await deps.install(ref, { ...(url ? { url } : {}), digest: info.digest });
      const report = result.packages.find((p) => p.package === info.manifest.package);
      const written = report?.items.find((i) => i.kind === "app" && i.name === plan.app)?.version;
      const appVersion = written ?? (await deps.workspace.getApp(plan.app))?.active;
      if (!appVersion) throw new Error(`serve_invalid: the install left no app ${plan.app}`);
      const problems = await deps.surfaceProblems(plan.surface);
      if (problems.length) throw new Error(`serve_invalid: ${SERVE_FILE}: ${problems.join("; ")}`);
      // The app HELD at the version just installed, as a person's public
      // view holds it: what visitors open until the next deploy moves it.
      const releases = await deps.apps.releases(plan.app);
      const live = releases?.releases.find((r) => r.id === releases.live);
      if (live?.version !== appVersion) await deps.apps.promote(plan.app, appVersion);
      await deps.setSurface(plan.surface);
      const view = await deps.apps.get(plan.app, appVersion).catch(() => null);
      const icon = view?.manifest.icon ? deps.icon?.(view.manifest.icon) : undefined;
      const description = plan.description ?? view?.manifest.description;
      state = {
        fetchedAt: at,
        serving: {
          package: info.manifest.package,
          version: info.manifest.version,
          digest: info.digest,
          ref,
          app: plan.app,
          appVersion,
          at,
          page: {
            app: plan.app,
            title: plan.title ?? view?.manifest.title ?? plan.app,
            ...(description ? { description } : {}),
            ...(plan.image ? { image: true } : {}),
            ...(icon ? { icon } : {}),
          },
          ...(plan.image ? { image: plan.image } : {}),
        },
      };
      await save();
      log(`[serve] deployed ${info.manifest.package} ${info.manifest.version} (${info.digest}): / is ${plan.app} ${appVersion}`);
      for (const w of result.warnings) warn(`[serve] ${info.manifest.package}: ${w}`);
      return { status: "deployed", digest };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      state = { ...state, error, errorAt: at, ...(digest ? { errorDigest: digest } : {}) };
      if (!digest) delete state.errorDigest;
      await save().catch(() => undefined);
      warn(`[serve] the deploy of ${deps.serve.ref} failed${state.serving ? `, still serving ${state.serving.package} ${state.serving.version} (${state.serving.digest})` : ", nothing is serving"}: ${error}`);
      return { status: "error", ...(digest ? { digest } : {}), error };
    }
  };

  // One run at a time; calls while one runs wait for one more run after it.
  let queued: Promise<SyncOutcome> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const sync = (): Promise<SyncOutcome> => {
    if (queued) return queued;
    const run = tail.catch(() => undefined).then(async () => {
      queued = undefined;
      deploying = true;
      try {
        return await deploy();
      } finally {
        deploying = false;
      }
    });
    queued = run;
    tail = run;
    return run;
  };

  return {
    ref: deps.serve,
    status: () => ({ ref: deps.serve.ref, ...(deps.serve.url ? { url: deps.serve.url } : {}), ...state, deploying }),
    page: () => state.serving?.page ?? null,
    imageFile: () => (state.serving?.image ? join(deps.cache.dirOf(state.serving.digest), ...state.serving.image.split("/")) : undefined),
    sync,
    follows: (key) => !key || (followedKey ? followedKey === key : byName),
  };
}
