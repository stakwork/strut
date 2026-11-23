/**
 * GIT CREDENTIALS BY HOST (stadeum plans/software.md §5, item 9): which
 * secret holds the token for a repository's host. One map for the box:
 * strut's own entry, `github.com` → `GITHUB_TOKEN` (what its git steps and
 * `git+` sources always read), and each installed package's
 * `provides.git: [{ host, secret }]`. A host is served by one secret: an
 * install that names another for a host the box serves already is refused
 * (src/packages/install.ts).
 *
 * The lookup is the URL's: `https://<host>/…` (or `http://` to this
 * machine, where nothing crosses a network) → the secret serving `<host>`,
 * read as the run reads any secret — its person's own, then the
 * deployment's (`SecretsCapability.git`, src/capabilities.ts). Any other
 * URL (`file:`, plain http to another machine, a host no secret serves)
 * gets no token. So a token goes only to the host it serves: never because
 * a caller named a secret (there is no `tokenSecret` any more), and never
 * over a wire anyone between can read. Git itself is held to it too: the
 * credential helper strut hands git answers only for the host it was given
 * (src/steps/lib/git/_shared.ts), so a redirect elsewhere gets nothing.
 *
 * An entry also names the FORGE'S STEPS for its host (plans/package-seams.md
 * §4): `repositories` and `pull_request`, which strut's `git/repositories`
 * and `git/pull-request` pick by host, so a caller names no forge.
 * github.com's own entry opens a pull request with strut's `github/create-pr`.
 */

/** A host a token serves, and the secret that holds it (`provides.git`) —
 *  and the FORGE'S STEPS for that host (plans/package-seams.md §4), each a
 *  full step type: `repositories`, what the token reaches, for
 *  `git/repositories`; `pull_request`, opening one, for `git/pull-request`.
 *  Each takes strut's input and answers strut's output, written on those
 *  two steps' descriptions. */
export interface GitHost {
  /** Lowercase hostname, with `:port` when it is not the scheme's default. */
  host: string;
  secret: string;
  repositories?: string;
  pull_request?: string;
}

/** The forge steps an entry may name. */
export const FORGE_STEPS = ["repositories", "pull_request"] as const;
export type ForgeStep = (typeof FORGE_STEPS)[number];

/** Strut's own entry: what its git steps and `git+` sources have always
 *  read for GitHub, and strut's own step that opens a pull request there.
 *  A package that declares the same is welcome; one that names another
 *  secret, or another step, for github.com is refused. */
export const STRUT_GIT_HOSTS: readonly GitHost[] = Object.freeze([{ host: "github.com", secret: "GITHUB_TOKEN", pull_request: "github/create-pr" }]);

/** A host as `provides.git` names it: a lowercase hostname, an optional port. */
export const GIT_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[1-9][0-9]{0,4})?$/;

/** Hosts a plain-http URL may carry a token to: this machine. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The host `url`'s token would serve (`github.com`, `git.acme.com:3000`),
 *  or undefined when no token may be sent to it: not https, nor http to
 *  this machine. */
export function tokenHost(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return u.host.toLowerCase();
  return undefined;
}

/** Which secret serves a repository URL's host, or undefined. */
export type GitSecretOf = (url: string) => string | undefined;

/** The lookup over `hosts`; the first entry for a host is the one. */
export function gitSecretOf(hosts: readonly GitHost[]): GitSecretOf {
  const map = new Map<string, string>();
  for (const h of hosts) if (!map.has(h.host)) map.set(h.host, h.secret);
  return (url) => {
    const host = tokenHost(url);
    return host ? map.get(host) : undefined;
  };
}

/** Strut's own lookup: a capability built with no map of the box's. */
export const strutGitSecret: GitSecretOf = gitSecretOf(STRUT_GIT_HOSTS);

/** The box's map: strut's own entry, then each package's, by package name. */
export function boxGitHosts(packages: ReadonlyArray<{ package: string; provides?: { git?: readonly GitHost[] } }>): GitHost[] {
  const out: GitHost[] = [...STRUT_GIT_HOSTS];
  for (const p of [...packages].sort((a, b) => a.package.localeCompare(b.package))) out.push(...(p.provides?.git ?? []));
  return out;
}

/** Each host two holders name with different secrets, or with different
 *  steps for one of its forge's steps, said for a refusal: `holders` in
 *  order, strut's own first. */
export function gitHostProblems(holders: ReadonlyArray<{ by: string; git?: readonly GitHost[] }>): string[] {
  const first = new Map<string, { by: string; secret: string }>();
  const steps = new Map<string, { by: string; step: string }>();
  const problems: string[] = [];
  for (const { by, git } of holders) {
    for (const h of git ?? []) {
      const had = first.get(h.host);
      if (!had) first.set(h.host, { by, secret: h.secret });
      else if (had.secret !== h.secret) problems.push(`${by} provides git for ${h.host} with ${h.secret}, which ${had.by} serves with ${had.secret}: a host is served by one secret`);
      for (const field of FORGE_STEPS) {
        const step = h[field];
        if (!step) continue;
        const named = steps.get(`${h.host} ${field}`);
        if (!named) steps.set(`${h.host} ${field}`, { by, step });
        else if (named.step !== step) problems.push(`${by} names ${step} as ${h.host}'s ${field} step, which ${named.by} names ${named.step}: a host has one`);
      }
    }
  }
  return problems;
}

/** A host's forge steps on the box: each the first holder's that names
 *  one (`hosts` in order, strut's own first; two that differ were refused
 *  at install). */
export function forgeStepsOf(hosts: readonly GitHost[], host: string): Partial<Record<ForgeStep, string>> {
  const out: Partial<Record<ForgeStep, string>> = {};
  for (const h of hosts) {
    if (h.host !== host) continue;
    for (const field of FORGE_STEPS) if (h[field] && !out[field]) out[field] = h[field];
  }
  return out;
}

/** The hosts on the box, each once, in order. */
export const gitHostNames = (hosts: readonly GitHost[]): string[] => [...new Set(hosts.map((h) => h.host))];

/** The box's git hosts as a step reads them (`ctx.services.gitHosts`): the
 *  map createStrut keeps after every package write. */
export interface GitHostsCapability {
  hosts(): readonly GitHost[];
}
