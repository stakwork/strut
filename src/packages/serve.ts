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
 *   signIn: [key, lnurl, nostr]     # how a visitor signs in (default: [sphinx]; [] for none)
 *   visitorKey: domain              # a child key per domain (default: root)
 *   limits: { writesPerDay: 500 }   # per-visitor limits over strut's defaults
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
 * FOLLOWED: a `git+` ref (src/packages/git-source.ts) is fetched every
 * `STRUT_SERVE_POLL_MINUTES` and on `POST /serve/sync` — a push webhook,
 * open to anyone and at most once a minute (`ping`) — and deployed when the
 * branch's commit moved and the package's digest with it; any other ref is
 * read again as a subscription is (src/packages/subscriptions.ts), at the
 * subscriptions' poll and on the publisher's ping, deployed when its digest
 * moved. One deploy at a time.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { AppsCapability } from "../apps/apps.js";
import type { ShellCapability } from "../capabilities.js";
import { defaultKitDir, type KitLocation } from "../apps/kit.js";
import { nameInPackage } from "../package-lookup.js";
import { DEFAULT_SIGN_IN, normalizeSurface, runnableShapeProblem, surfaceProblem, VISITOR_METHOD_NAMES, type PublicRunnable, type PublicSurface } from "../public-surface.js";
import type { WorkspaceStore } from "../workspace.js";
import { loadYaml } from "../yaml.js";
import { bootPackageProblem } from "./boot.js";
import { resolvePackage, type CachedPackage, type PackageCache, type ResolvedPackage } from "./cache.js";
import { PACKAGE_NAME, type PackageInfo } from "./format.js";
import type { InstallResult } from "./install.js";
import { parsePkRef } from "./pk.js";

export const SERVE_FILE = "serve.yaml";
/** Where a served box keeps what it serves, beside `public.json`. */
export const SERVE_STATE_FILE = "serve.json";

/** What `STRUT_SERVE` (+ `STRUT_SERVE_URL`, `STRUT_SERVE_TOKEN_SECRET`) and `createStrut({ serve })` name. */
export interface ServeRef {
  /** `publisher/name` (through the followed indexes), `pk:<key>/<publisher>/<name>` with `url`,
   *  `git+https://host/org/repo[@<branch|tag|commit>][#<folder>]`, or `file:/path`. */
  ref: string;
  /** A `pk:` ref's catalog: the publisher's `…/packages/catalog?public=1`. */
  url?: string;
  /** A `git+` ref's token: the NAME of the secret it is read with
   *  (default GITHUB_TOKEN; plans/app-repos.md §4.7). A public repo needs none. */
  tokenSecret?: string;
}

/** The ref from the options, else the environment; undefined when neither
 *  names one. A bad ref throws, so it fails the boot. */
export function serveRefOf(opt: ServeRef | false | undefined, env: Record<string, string | undefined>): ServeRef | undefined {
  if (opt === false) return undefined;
  const fromEnv = (name: string) => env[name]?.trim() || undefined;
  const raw: ServeRef | undefined =
    opt ??
    (fromEnv("STRUT_SERVE")
      ? {
          ref: fromEnv("STRUT_SERVE")!,
          ...(fromEnv("STRUT_SERVE_URL") ? { url: fromEnv("STRUT_SERVE_URL")! } : {}),
          ...(fromEnv("STRUT_SERVE_TOKEN_SECRET") ? { tokenSecret: fromEnv("STRUT_SERVE_TOKEN_SECRET")! } : {}),
        }
      : undefined);
  if (!raw) return undefined;
  const label = opt ? "serve" : "STRUT_SERVE";
  const problem = bootPackageProblem({ ref: raw.ref, ...(raw.url !== undefined ? { url: raw.url } : {}), ...(raw.tokenSecret !== undefined ? { tokenSecret: raw.tokenSecret } : {}) });
  if (problem) throw new Error(`${label}: ${opt ? problem : problem.replace(/\burl\b/g, "STRUT_SERVE_URL").replace(/\btokenSecret\b/g, "STRUT_SERVE_TOKEN_SECRET")}`);
  return { ref: raw.ref, ...(raw.url ? { url: raw.url } : {}), ...(raw.tokenSecret ? { tokenSecret: raw.tokenSecret } : {}) };
}

/** How often a `git+` ref is fetched, in minutes: `STRUT_SERVE_POLL_MINUTES`,
 *  default 5; 0 = at boot and on `POST /serve/sync` only. */
export const SERVE_POLL_MINUTES = 5;
/** `POST /serve/sync` fetches at most once in this long; a ping inside it is
 *  one more fetch when it is up. */
export const SERVE_PING_INTERVAL_MS = 60_000;

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
    signIn: z.array(z.enum(VISITOR_METHOD_NAMES, { message: `signIn lists sign-ins strut knows: ${VISITOR_METHOD_NAMES.join(", ")}` })).optional(),
    visitorKey: z.enum(["root", "domain"], { message: "visitorKey is root or domain" }).optional(),
    limits: z
      .object({
        writesPerDay: z.number().int().min(0, "writesPerDay is 0 or more").optional(),
        launchesPerDay: z.number().int().min(0, "launchesPerDay is 0 or more").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ServeFile = Omit<z.infer<typeof serveSchema>, "runnable"> & { runnable?: PublicRunnable[] };

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
        return `unknown field${keys.length > 1 ? "s" : ""} ${keys.join(", ")} — ${SERVE_FILE} is { app, title?, description?, image?, reads?, runnable?, concepts?, signIn?, visitorKey?, limits? }`;
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
    // No `signIn`: strut's default (normalizeSurface leaves it unwritten
    // when nothing else is said); `signIn: []`: no sign-in.
    visitors: {
      signIn: file.signIn ?? DEFAULT_SIGN_IN,
      ...(file.visitorKey === "domain" ? { visitorKey: "domain" as const } : {}),
      ...(file.limits && Object.keys(file.limits).length ? { limits: file.limits } : {}),
    },
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
  /** The commit a `git+` ref resolved to: the one deployed, or a later one
   *  whose package was the same (its digest unchanged, nothing deployed). */
  commit?: string;
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
  /** The commit it was at, for a `git+` ref. */
  errorCommit?: string;
}

/** `GET /serve`. */
export interface ServeStatus extends ServeState {
  ref: string;
  url?: string;
  /** The secret a `git+` ref is read with (a NAME). */
  tokenSecret?: string;
  deploying: boolean;
  /** A `POST /serve/sync` waiting for its minute: when it fetches. */
  pingAt?: string;
}

/** What `POST /serve/sync` answers: a fetch now, or one when the minute since the last is up. */
export interface PingOutcome {
  status: "syncing" | "queued";
  at: string;
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
  /** One install through the distro's door: `commit` is the one a `git+`
   *  ref's digest was read at, for its versions' `upstream`. */
  install(ref: string, opts: { url?: string; digest: string; tokenSecret?: string; commit?: string }): Promise<InstallResult>;
  /** A `git+` ref's token: reads a secret by name. */
  secret?(name: string): Promise<string | undefined>;
  /** What a `git+` ref runs git with (default: a local shell). */
  shell?: ShellCapability;
  /** `ping`'s minimum interval (default `SERVE_PING_INTERVAL_MS`). */
  pingIntervalMs?: number;
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
  /** `POST /serve/sync`, a push webhook: `sync` now, at most once a minute —
   *  a ping inside the minute is one more sync when it is up. */
  ping(): PingOutcome;
  /** The publisher's ping names a key: is it this ref's? */
  follows(key?: string): boolean;
  /** Drops a ping waiting for its minute, and waits for a deploy in flight. */
  close(): Promise<void>;
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
  const fetchRef = async (): Promise<{ info: ResolvedPackage | CachedPackage; ref: string; url?: string }> => {
    const { ref, url, tokenSecret } = deps.serve;
    const opts = { cache: deps.cache, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
    if (ref.startsWith("git+")) {
      // The commit serving still the branch's: nothing to read out.
      const serving = state.serving;
      const known = serving?.commit && serving.ref === ref ? { known: { commit: serving.commit, digest: serving.digest } } : {};
      const git = { dataDir: deps.dataDir, ...(tokenSecret ? { tokenSecret } : {}), ...(deps.secret ? { secret: deps.secret } : {}), ...(deps.shell ? { shell: deps.shell } : {}), ...known };
      return { info: await resolvePackage(ref, { ...opts, ...git }), ref };
    }
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
    let commit: string | undefined;
    try {
      const { info, ref, url } = await fetchRef();
      digest = info.digest;
      commit = "commit" in info ? info.commit : undefined;
      state.fetchedAt = at;
      if (state.serving?.digest === info.digest) {
        const { error: _e, errorAt: _a, errorDigest: _d, errorCommit: _c, ...kept } = state;
        state = kept;
        // The branch moved and the package did not: the same tree serves.
        if (commit && state.serving) state.serving = { ...state.serving, commit };
        await save();
        return { status: "current", digest };
      }
      // A bad serve.yaml stops here, before anything is written.
      const plan = await readServePlan(info);
      const { tokenSecret } = deps.serve;
      const result = await deps.install(ref, { ...(url ? { url } : {}), digest: info.digest, ...(tokenSecret ? { tokenSecret } : {}), ...(commit ? { commit } : {}) });
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
          ...(commit ? { commit } : {}),
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
      log(`[serve] deployed ${info.manifest.package} ${info.manifest.version} (${info.digest}${commit ? `, commit ${commit}` : ""}): / is ${plan.app} ${appVersion}`);
      for (const w of result.warnings) warn(`[serve] ${info.manifest.package}: ${w}`);
      return { status: "deployed", digest };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      state = { ...state, error, errorAt: at, ...(digest ? { errorDigest: digest } : {}), ...(commit ? { errorCommit: commit } : {}) };
      if (!digest) delete state.errorDigest;
      if (!commit) delete state.errorCommit;
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

  // The webhook's ping: a fetch now, else one when the minute is up.
  const interval = deps.pingIntervalMs ?? SERVE_PING_INTERVAL_MS;
  let lastPing = -Infinity;
  let pingAt: number | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  const ping = (): PingOutcome => {
    const now = Date.now();
    if (pingAt !== undefined) return { status: "queued", at: new Date(pingAt).toISOString() };
    if (now - lastPing >= interval) {
      lastPing = now;
      void sync();
      return { status: "syncing", at: new Date(now).toISOString() };
    }
    pingAt = lastPing + interval;
    pingTimer = setTimeout(() => {
      pingAt = pingTimer = undefined;
      lastPing = Date.now();
      void sync();
    }, pingAt - now);
    pingTimer.unref?.();
    return { status: "queued", at: new Date(pingAt).toISOString() };
  };

  return {
    ref: deps.serve,
    status: () => ({
      ref: deps.serve.ref,
      ...(deps.serve.url ? { url: deps.serve.url } : {}),
      ...(deps.serve.tokenSecret ? { tokenSecret: deps.serve.tokenSecret } : {}),
      ...state,
      deploying,
      ...(pingAt !== undefined ? { pingAt: new Date(pingAt).toISOString() } : {}),
    }),
    page: () => state.serving?.page ?? null,
    imageFile: () => (state.serving?.image ? join(deps.cache.dirOf(state.serving.digest), ...state.serving.image.split("/")) : undefined),
    sync,
    ping,
    follows: (key) => !key || (followedKey ? followedKey === key : byName),
    close: async () => {
      clearTimeout(pingTimer);
      pingAt = pingTimer = undefined;
      await tail.catch(() => undefined);
    },
  };
}
