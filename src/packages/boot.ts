/**
 * Packages installed at FIRST BOOT (`STRUT_PACKAGES`, `createStrut({
 * packages })`): a box that should come up with a package on it — a
 * team's workspace with the legal desk — names it once, and every boot
 * installs each listed package that is not installed yet. Never an update:
 * a package already here, at any digest, is left alone (a person updates
 * it, or a subscription does, src/packages/subscriptions.ts). Never the
 * boot's failure: a catalog that does not answer is a log line, and the
 * next boot tries again.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidSecretName } from "../secret-store.js";
import { loadYaml } from "../yaml.js";
import { fileRefPath } from "./cache.js";
import { MANIFEST_FILE, PACKAGE_DIGEST, PACKAGE_NAME } from "./format.js";
import { parseGitRef } from "./git-source.js";
import type { InstallResult } from "./install.js";
import { parsePkRef } from "./pk.js";

/** One package to install at boot: what `POST /packages/install` takes. */
export interface BootPackage {
  /** `publisher/name` (through the followed indexes), `pk:<key>/<publisher>/<name>[@digest]` with `url`,
   *  `git+https://host/org/repo[@<branch|tag|commit>][#<folder>]`, or `file:/path`. */
  ref: string;
  /** A `pk:` ref's catalog: the publisher's `…/packages/catalog?public=1`. */
  url?: string;
  /** The digest `ref` must resolve to. */
  digest?: string;
  /** A `git+` ref's token: the NAME of the secret it is read with (default GITHUB_TOKEN). */
  tokenSecret?: string;
}

const ENTRY = "{ ref, url?, digest?, tokenSecret? }";
const REFS = "publisher/name, pk:<key>/<publisher>/<name> with url, git+https://host/org/repo@<branch|tag|commit>[#<folder>], or file:/path";

/** Why `p` is not a `BootPackage`, or null. */
export function bootPackageProblem(p: unknown): string | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return `an entry is ${ENTRY}`;
  const { ref, url, digest, tokenSecret, ...rest } = p as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) return `unknown field ${extra.map((k) => JSON.stringify(k)).join(", ")}: an entry is ${ENTRY}`;
  if (typeof ref !== "string" || !ref) return `ref is required: ${REFS}`;
  if (url !== undefined && (typeof url !== "string" || !/^https?:\/\/\S+$/.test(url))) return `${ref}: url is the publisher's catalog, an http(s) URL`;
  if (digest !== undefined && (typeof digest !== "string" || !PACKAGE_DIGEST.test(digest))) return `${ref}: digest is sha256:<64 hex>`;
  if (tokenSecret !== undefined && (typeof tokenSecret !== "string" || !isValidSecretName(tokenSecret))) return `${ref}: tokenSecret is the NAME of a secret (letters, digits, underscore), never the token`;
  if (tokenSecret !== undefined && !ref.startsWith("git+")) return `${ref}: tokenSecret goes with a git+ ref`;
  if (PACKAGE_NAME.test(ref)) {
    if (url !== undefined) return `${ref} is a name, looked up in the indexes this strut follows; a url goes with a pk: ref`;
  } else if (ref.startsWith("pk:")) {
    const pk = parsePkRef(ref);
    if (typeof pk === "string") return pk;
    if (url === undefined) return `${ref}: a pk: ref needs url, where the publisher's catalog is served`;
  } else if (ref.startsWith("git+")) {
    const git = parseGitRef(ref);
    if (typeof git === "string") return git;
    if (url !== undefined) return `${ref}: a url goes with a pk: ref; a git+ ref names its repository itself`;
  } else if (!ref.startsWith("file:")) {
    return `${ref}: a ref is ${REFS}`;
  }
  return null;
}

/** `STRUT_PACKAGES` → the list, or a thrown error naming the bad entry.
 *  Unset or empty: nothing. */
export function parseBootPackagesEnv(raw: string | undefined): BootPackage[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`STRUT_PACKAGES is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`STRUT_PACKAGES is a JSON list of ${ENTRY}`);
  return checkBootPackages(parsed, "STRUT_PACKAGES");
}

/** Each entry checked, or a thrown error naming the bad one. */
export function checkBootPackages(list: readonly unknown[], label = "packages"): BootPackage[] {
  return list.map((p, i) => {
    const problem = bootPackageProblem(p);
    if (problem) throw new Error(`${label}[${i}]: ${problem}`);
    const { ref, url, digest, tokenSecret } = p as BootPackage;
    return { ref, ...(url ? { url } : {}), ...(digest ? { digest } : {}), ...(tokenSecret ? { tokenSecret } : {}) };
  });
}

/** The package a ref names, when that is cheap to tell: the name itself,
 *  a `pk:` ref's, a `file:` directory's `strut.yaml`. A `git+` ref's is
 *  known only once fetched: an installed package that records the ref. */
export async function bootPackageName(ref: string): Promise<string | undefined> {
  if (PACKAGE_NAME.test(ref)) return ref;
  if (ref.startsWith("pk:")) {
    const pk = parsePkRef(ref);
    return typeof pk === "string" ? undefined : pk.package;
  }
  if (ref.startsWith("git+")) return undefined;
  try {
    const manifest = loadYaml(await readFile(join(fileRefPath(ref), MANIFEST_FILE), "utf-8")) as { package?: unknown };
    return typeof manifest?.package === "string" ? manifest.package : undefined;
  } catch {
    return undefined; // the install says what is wrong with it
  }
}

export interface BootPackageOutcome {
  ref: string;
  package?: string;
  /** `installed`: written now; `present`: here already (left alone, or an
   *  install that found everything in place); `failed`: see `error`. */
  status: "installed" | "present" | "failed";
  version?: string;
  digest?: string;
  missing?: InstallResult["missing"];
  error?: string;
}

export interface BootPackageDeps {
  /** The packages installed here now (`listInstalledPackages`), each with
   *  the ref it was installed from. */
  installed(): Promise<Array<{ package: string; ref?: string }>>;
  install(ref: string, opts: { url?: string; digest?: string; tokenSecret?: string }): Promise<InstallResult>;
  log?(line: string): void;
  warn?(line: string): void;
}

/** Install each listed package not installed yet, one at a time, in order.
 *  Never throws: a failure is an outcome and a warning. */
export async function installBootPackages(list: readonly BootPackage[], deps: BootPackageDeps): Promise<BootPackageOutcome[]> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const out: BootPackageOutcome[] = [];
  for (const p of list) {
    let name = await bootPackageName(p.ref);
    try {
      const installed = await deps.installed();
      // A ref whose name is not cheap to tell (git+) is here when an
      // installed package records that very ref.
      name ??= installed.find((i) => i.ref === p.ref)?.package;
      if (name && installed.some((i) => i.package === name)) {
        out.push({ ref: p.ref, package: name, status: "present" });
        continue;
      }
      // A package of graph types alone (graph/) leaves no version record,
      // so `installed` never lists it and every boot installs it again:
      // harmless — types are add-only and come back `present` — and the
      // report says so, which is all that is logged.
      const r = await deps.install(p.ref, { ...(p.url ? { url: p.url } : {}), ...(p.digest ? { digest: p.digest } : {}), ...(p.tokenSecret ? { tokenSecret: p.tokenSecret } : {}) });
      const report = r.packages.find((m) => m.package === r.package);
      const status = report?.status === "present" ? "present" : "installed";
      const missing = [...r.missing.secrets.map((s) => `secret ${s}`), ...r.missing.binaries.map((b) => `binary ${b}`), ...r.missing.runtimes.map((t) => `runtime ${t}`)];
      out.push({ ref: p.ref, package: r.package, status, ...(report ? { version: report.version } : {}), digest: r.digest, missing: r.missing });
      if (status === "installed") log(`[packages] installed at boot: ${r.package}${report ? ` ${report.version}` : ""} (${r.digest})`);
      if (missing.length) warn(`[packages] ${r.package} needs what this deployment does not provide: ${missing.join(", ")}`);
      for (const w of r.warnings) warn(`[packages] ${r.package}: ${w}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      out.push({ ref: p.ref, ...(name ? { package: name } : {}), status: "failed", error });
      warn(`[packages] could not install ${name ?? p.ref} at boot (tried again next boot): ${error}`);
    }
  }
  return out;
}
