/**
 * The process environment, read in ONE place.
 *
 * The server's env is where the deployment's credentials arrive —
 * STRUT_API_KEY, STRUT_SECRET_KEY (the key to every encrypted store under
 * the data dir), provider keys, NEO4J_PASSWORD. A step is TypeScript that
 * runs in this process, so `process.env` is readable by any step — in-tree,
 * custom, or installed from a package — and by any child a step spawns with
 * it. The secrets boundary (`ctx.services.secrets`) and the scrubbed child
 * env (`shell.ts`) are conventions; this module is what makes them hold:
 *
 * - `bootEnv()` is what strut's own code reads instead of `process.env`
 *   (a test in env.test.ts fails on a `process.env[...]` read anywhere else
 *   under src/). Until the scrub runs it IS `process.env`, so a host that
 *   embeds strut, and every test, sees no change.
 * - `scrubProcessEnv()` — called by the default server's entry
 *   (`startServer`, so `server.ts` and `desktop.js`), never by `createStrut`
 *   — copies the env into the boot snapshot and deletes everything but
 *   `KEEP_ENV` (what a shell needs to behave) from `process.env`. From then
 *   on the secrets capability still resolves a key the deployment set in
 *   env, through the snapshot, while a step's `process.env.X`, or a child it
 *   spawns with `process.env`, sees nothing. `STRUT_ENV_SCRUB=0` turns it
 *   off; `STRUT_ENV_KEEP=A,B` keeps named variables a library strut loads
 *   reads from the env itself (a proxy, a browsers path).
 *
 * Known limit: on Linux the kernel keeps the exec-time environment readable
 * at /proc/<pid>/environ by the same user, and `delete process.env.X` does
 * not overwrite it. A deployment that must close that too passes secrets
 * some other way than env (the secret store, a file) — the scrub covers what
 * JavaScript and a spawned child can see.
 */

/** What stays in `process.env` after the scrub: what a shell needs to run
 *  tools from PATH, resolve ~, write temp files, keep git/locale sane — the
 *  same list `shell.ts` gives every child — plus what Node and the runtime
 *  libraries read lazily (time zone, proxies, TLS roots) and what Windows
 *  needs to spawn anything at all. Never a credential. */
export const KEEP_ENV: readonly string[] = [
  // The child allowlist (shell.ts `minimalEnv`).
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  // Read by Node and libraries after boot.
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // esbuild reads it when the app build first loads it: where its binary is
  // when no @esbuild/<platform> package holds it (the desktop package's native/).
  "ESBUILD_BINARY_PATH",
  // Windows cannot spawn without these.
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemDrive",
  "SYSTEMDRIVE",
  "ProgramFiles",
  "PROGRAMFILES",
  "ProgramData",
  "PROGRAMDATA",
  "windir",
  "WINDIR",
];

let snapshot: NodeJS.ProcessEnv = process.env;
let scrubbed: string[] | null = null;

/** The environment strut booted with. `process.env` itself until
 *  `scrubProcessEnv()` ran; the copy it took after. */
export function bootEnv(): NodeJS.ProcessEnv {
  return snapshot;
}

/** Copy `process.env` into the boot snapshot, then delete every variable not
 *  in `KEEP_ENV` (+ `opts.keep`, + `STRUT_ENV_KEEP`) from `process.env`.
 *  Returns the names removed, sorted. Idempotent: a second call changes
 *  nothing and returns the first call's list. */
export function scrubProcessEnv(opts: { keep?: readonly string[] } = {}): string[] {
  if (scrubbed) return scrubbed;
  snapshot = { ...process.env };
  const keep = new Set<string>([
    ...KEEP_ENV,
    ...(opts.keep ?? []),
    ...(process.env["STRUT_ENV_KEEP"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ]);
  scrubbed = Object.keys(process.env)
    .filter((k) => !keep.has(k))
    .sort();
  for (const k of scrubbed) delete process.env[k];
  return scrubbed;
}

/** Whether the default server scrubs: `STRUT_ENV_SCRUB` unset or anything
 *  but `0`. Read from the env as it is, since this decides the scrub. */
export function scrubRequested(env: NodeJS.ProcessEnv = bootEnv()): boolean {
  return env["STRUT_ENV_SCRUB"] !== "0";
}
