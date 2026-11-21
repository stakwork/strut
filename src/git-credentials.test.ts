/**
 * Git credentials by host (src/git-hosts.ts; stadeum plans/software.md §5,
 * item 9): which secret serves a repository's host, `secrets.git(url)`,
 * `git/remote-head`, and what a package's step holds — against repositories
 * served over http on this machine (src/test-util/git-remote.ts), which
 * record the token each request carried.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { actorSecretStore } from "./actor-secrets.js";
import { secretsCapability, standardServices, type StrutCapabilities } from "./capabilities.js";
import { defineStep, flow, step, type RunEvent, type Step, type StepContext, type StepRegistry } from "./core.js";
import { boxGitHosts, gitHostProblems, gitSecretOf, STRUT_GIT_HOSTS, strutGitSecret, tokenHost } from "./git-hosts.js";
import { fenceStep, type Fence } from "./packages/fence.js";
import { runWorkflow } from "./runner.js";
import { packageCache, resolvePackage } from "./packages/cache.js";
import { MemorySecretStore } from "./secret-store.js";
import { runProcess } from "./shell.js";
import checkout from "./steps/lib/git/checkout.js";
import remoteHead from "./steps/lib/git/remote-head.js";
import { serveGit, type GitServer } from "./test-util/git-remote.js";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("which secret serves a repository's host", () => {
  it("strut's own github.com, then each package's host — over https, or http to this machine alone", () => {
    const secretOf = gitSecretOf(
      boxGitHosts([
        { package: "acme/lab", provides: { git: [{ host: "127.0.0.1:8123", secret: "LAB_TOKEN" }] } },
        { package: "acme/forge", provides: { git: [{ host: "git.acme.test", secret: "FORGE_TOKEN" }] } },
        { package: "acme/plain" },
      ]),
    );
    assert.equal(secretOf("https://github.com/acme/widgets"), "GITHUB_TOKEN");
    assert.equal(secretOf("https://GitHub.com:443/acme/widgets.git"), "GITHUB_TOKEN", "a host is a host, in any case, on its default port");
    assert.equal(secretOf("https://git.acme.test/team/app"), "FORGE_TOKEN");
    assert.equal(secretOf("http://127.0.0.1:8123/acme/app.git"), "LAB_TOKEN");
    for (const url of [
      "https://gitlab.com/acme/app", // a host no package serves
      "https://git.acme.test:8443/team/app", // another port is another host
      "https://api.github.com/acme/widgets", // and a subdomain another
      "http://github.com/acme/widgets", // plain http, to another machine
      "http://git.acme.test/team/app",
      "file:///srv/git/app",
      "not a url",
    ]) {
      assert.equal(secretOf(url), undefined, url);
    }
    assert.equal(strutGitSecret("https://git.acme.test/team/app"), undefined, "strut's own map knows github.com alone");
    assert.deepEqual(
      ["https://github.com/a/b", "http://localhost:3000/a/b", "http://[::1]:3000/a/b", "http://10.0.0.2/a/b"].map(tokenHost),
      ["github.com", "localhost:3000", "[::1]:3000", undefined],
    );
  });

  it("a host is served by one secret: the same one again is welcome, another is a conflict", () => {
    assert.deepEqual(gitHostProblems([{ by: "strut", git: STRUT_GIT_HOSTS }, { by: "acme/github", git: [{ host: "github.com", secret: "GITHUB_TOKEN" }] }]), []);
    assert.deepEqual(
      gitHostProblems([
        { by: "strut", git: STRUT_GIT_HOSTS },
        { by: "acme/gh", git: [{ host: "github.com", secret: "GH_PAT" }] },
        { by: "a/one", git: [{ host: "git.acme.test", secret: "A" }] },
        { by: "a/two", git: [{ host: "git.acme.test", secret: "B" }] },
      ]),
      [
        "acme/gh provides git for github.com with GH_PAT, which strut serves with GITHUB_TOKEN: a host is served by one secret",
        "a/two provides git for git.acme.test with B, which a/one serves with A: a host is served by one secret",
      ],
    );
  });

  it("secrets.git reads that secret as the run reads it: the person's own first, then the deployment's", async () => {
    const deployment = new MemorySecretStore();
    await deployment.set("GITHUB_TOKEN", "deployment-gh");
    await deployment.set("FORGE_TOKEN", "deployment-forge");
    const actors = actorSecretStore(new MemorySecretStore());
    await actors.set("ada", "GITHUB_TOKEN", "ada-gh");
    const cap = secretsCapability(deployment, { actors, gitSecret: gitSecretOf([...STRUT_GIT_HOSTS, { host: "git.acme.test", secret: "FORGE_TOKEN" }]) });
    assert.equal(await cap.git!("https://github.com/a/b"), "deployment-gh");
    const ada = cap.forPrincipal!("ada");
    assert.equal(await ada.git!("https://github.com/a/b"), "ada-gh");
    assert.equal(await ada.git!("https://git.acme.test/a/b"), "deployment-forge");
    assert.equal(await ada.git!("https://evil.example/a/b"), undefined);
    // A capability built with no map of the box's reads strut's own.
    const plain = secretsCapability({ GITHUB_TOKEN: "env-gh", FORGE_TOKEN: "env-forge" });
    assert.deepEqual([await plain.git!("https://github.com/a/b"), await plain.git!("https://git.acme.test/a/b")], ["env-gh", undefined]);
  });
});

describe("git/remote-head and the token git is handed, against repositories served over http", () => {
  const TOKEN = "lab-token-SENTINEL-71c2";
  const GH = "ghp_person-SENTINEL-0a9f";
  let root: string;
  let dataDir: string;
  let head: string;
  let open: GitServer;
  let priv: GitServer;
  let moved: GitServer;
  const repoOf = (s: GitServer) => `${s.url}/acme/widgets.git`;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-git-hosts-"));
    dataDir = join(root, "data");
    const repos = join(root, "repos");
    const seed = join(root, "seed");
    await mkdir(seed, { recursive: true });
    git(seed, "init", "--quiet", "-b", "trunk");
    await writeFile(join(seed, "README.md"), "# widgets\n");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "init");
    head = git(seed, "rev-parse", "HEAD");
    git(root, "init", "--quiet", "--bare", "-b", "trunk", join(repos, "acme", "widgets.git"));
    git(seed, "push", "--quiet", join(repos, "acme", "widgets.git"), "trunk");
    open = await serveGit(repos);
    priv = await serveGit(repos, { token: TOKEN });
    moved = await serveGit(repos, { redirect: priv.url });
  });
  after(async () => {
    await Promise.all([open.close(), priv.close(), moved.close()]);
    await rm(root, { recursive: true, force: true });
  });

  /** The box: strut's own entry, and `hosts` → LAB_TOKEN. */
  const services = (secrets: Record<string, string>, hosts: GitServer[] = []) =>
    standardServices({ secretsSource: secrets, dataDir, gitSecret: gitSecretOf([...STRUT_GIT_HOSTS, ...hosts.map((s) => ({ host: s.host, secret: "LAB_TOKEN" }))]) });
  const registry = { "git/remote-head": remoteHead, "git/checkout": checkout } as StepRegistry;
  const run = async (steps: Step[], bag: StrutCapabilities, reg: StepRegistry = registry) => {
    const events: RunEvent[] = [];
    const res = await runWorkflow(flow("t", { input: z.object({}), steps }), {}, reg, { services: bag, onEvent: (e) => void events.push(e) });
    return { res, said: JSON.stringify([res, events]) };
  };
  const ask = (repo: string) => step("head", "git/remote-head", { repo });

  it("asks a public repository with no token: its default branch and head, nothing written", async () => {
    const { res } = await run([ask(repoOf(open))], services({}));
    assert.equal(res.status, "success", res.error?.message);
    assert.deepEqual(res.output, { branch: "trunk", head });
    assert.ok(open.seen.every((r) => r.password === undefined));
    assert.equal(existsSync(join(dataDir, "repos")), false, "no clone, no cache");
  });

  it("asks a private one with the run's token for its host — the token in no output, event or error", async () => {
    const { res, said } = await run([ask(repoOf(priv))], services({ LAB_TOKEN: TOKEN }, [priv]));
    assert.equal(res.status, "success", res.error?.message);
    assert.deepEqual(res.output, { branch: "trunk", head });
    assert.ok(priv.seen.some((r) => r.password === TOKEN), "git sent it, to its host");
    assert.ok(!said.includes(TOKEN));

    // No value for the secret that serves the host: asked with none.
    const none = await run([ask(repoOf(priv))], services({}, [priv]));
    assert.match(none.res.error!.message, /^remote_denied: http:\/\/127\.0\.0\.1:\d+\/acme\/widgets\.git asks for a credential — it is private, or there is no repository there — and this run has no token for its host$/);
    // A value the host refuses: said, never shown.
    const wrong = await run([ask(repoOf(priv))], services({ LAB_TOKEN: "wrong-SENTINEL" }, [priv]));
    assert.match(wrong.res.error!.message, /^remote_denied: .* refused the run's token for 127\.0\.0\.1:\d+: it cannot read this repository, or there is none there$/);
    assert.ok(!wrong.said.includes("wrong-SENTINEL"));
    const missing = await run([ask(`${open.url}/acme/nothing.git`)], services({}));
    assert.match(missing.res.error!.message, /^remote_not_found: no repository at /);
  });

  it("never sends a token to a host it does not serve: the person's GITHUB_TOKEN stays GitHub's", async () => {
    // Before git credentials by host, git/checkout (and git/push, and a git+
    // ref) read `tokenSecret`, GITHUB_TOKEN unless named, whatever the host,
    // and git's helper answered every host: any URL a workflow, an agent's
    // tool call or a package named got the person's GitHub token.
    const bag = services({ GITHUB_TOKEN: GH });
    const before = priv.seen.length;
    const asked = await run([ask(repoOf(priv))], bag);
    assert.match(asked.res.error!.message, /^remote_denied: .*this run has no token for its host$/);
    const checked = await run([step("co", "git/checkout", { repo: repoOf(priv) })], bag);
    assert.equal(checked.res.status, "error");
    assert.ok(priv.seen.length > before, "the host was asked");
    assert.ok(priv.seen.every((r) => r.password !== GH), "and never got the GitHub token");
    assert.ok(!asked.said.includes(GH) && !checked.said.includes(GH));
  });

  it("and git's helper answers for that host alone: a redirect to another host gets nothing", async () => {
    // `moved` is a host the box serves; it sends git on to `priv`, which wants a token.
    const before = priv.seen.length;
    const { res, said } = await run([ask(repoOf(moved))], services({ LAB_TOKEN: TOKEN }, [moved]));
    assert.equal(res.status, "error");
    assert.ok(priv.seen.length > before, "git followed the redirect");
    assert.ok(priv.seen.slice(before).every((r) => r.password === undefined), "the token went to no other host");
    assert.ok(!said.includes(TOKEN));
  });

  /**
   * A machine that holds git credentials: a helper as a system gitconfig
   * sets one (macOS's osxkeychain), a global config's askpass and helper, a
   * ~/.netrc that git's curl reads on its own — each a password of its own,
   * unless one is given. Its shell runs git on that machine, and on that
   * machine alone: the real one's system layer is never read
   * (`GIT_CONFIG_NOSYSTEM`; on a Mac, Apple Git reads its Xcode gitconfig,
   * whose osxkeychain would ask the real keychain and could wait on its
   * dialog, as part of that layer, which `GIT_CONFIG_SYSTEM` adds to rather
   * than replaces), so the test's "system" helper comes on the command line,
   * before strut's own arguments, as a system file is read before them.
   */
  const machineWith = async (name: string, passwords: { system?: string; global?: string; netrc?: string } = {}) => {
    const dir = join(root, `machine-${name}`);
    const home = join(dir, "home");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".netrc"), `machine 127.0.0.1 login machine password ${passwords.netrc ?? "MACHINE_NETRC"}\n`);
    const askpass = join(dir, "askpass.sh");
    await writeFile(askpass, "#!/bin/sh\necho MACHINE_ASKPASS\n", { mode: 0o755 });
    const global = join(dir, "gitconfig");
    await writeFile(global, `[credential]\n\thelper = "!f() { echo username=machine; echo password=${passwords.global ?? "MACHINE_GLOBAL"}; }; f"\n[core]\n\taskPass = ${askpass}\n`);
    const system = `credential.helper=!f() { echo username=machine; echo password=${passwords.system ?? "MACHINE_SYSTEM"}; }; f`;
    const shell: StrutCapabilities["shell"] = (req) =>
      runProcess(req.cmd !== "git" ? req : { ...req, args: ["-c", system, ...(req.args ?? [])], env: { GIT_CONFIG_NOSYSTEM: "1", HOME: home, GIT_CONFIG_GLOBAL: global, ...req.env } });
    return { shell, on: (bag: StrutCapabilities): StrutCapabilities => ({ ...bag, shell }) };
  };
  const machinePasswords = (from: number) => [...new Set(priv.seen.slice(from).map((r) => r.password).filter((p): p is string => !!p && p.startsWith("MACHINE_")))];

  it("uses none of the machine's own credentials — with no token, or for another host — on every git path", async () => {
    const machine = await machineWith("server");
    const before = priv.seen.length;

    // No token for the host: strut's git steps, and a git+ read.
    const asked = await run([ask(repoOf(priv))], machine.on(services({})));
    assert.match(asked.res.error!.message, /^remote_denied: /);
    const checked = await run([step("co", "git/checkout", { repo: repoOf(priv) })], machine.on(services({})));
    assert.equal(checked.res.status, "error");
    await assert.rejects(resolvePackage(`git+${repoOf(priv)}@trunk`, { cache: packageCache(join(root, "pkgs")), shell: machine.shell, dataDir }), /^Error: package_repo_denied: /);
    // A token for one host, sent on to another: that one gets no machine's either.
    const movedOn = await run([ask(repoOf(moved))], machine.on(services({ LAB_TOKEN: TOKEN }, [moved])));
    assert.equal(movedOn.res.status, "error");

    assert.ok(priv.seen.length > before, "the host was asked");
    assert.deepEqual(priv.seen.slice(before).filter((r) => r.password !== undefined), [], "and got no credential at all");
  });

  describe("on a person's own machine (STRUT_GIT_LOCAL)", () => {
    /** The box with git local: strut's own entry, and `hosts` → LAB_TOKEN. */
    const local = (secrets: Record<string, string>, hosts: GitServer[] = []) =>
      standardServices({ secretsSource: secrets, dataDir, gitLocal: true, gitSecret: gitSecretOf([...STRUT_GIT_HOSTS, ...hosts.map((s) => ({ host: s.host, secret: "LAB_TOKEN" }))]) });

    it("with no token for the host, git keeps the machine's own: its ~/.netrc, its helpers — on every git path", async () => {
      // ~/.netrc holds the one that works: curl sends it, the step reads the head.
      const byNetrc = await machineWith("netrc", { netrc: TOKEN });
      // The machine is the test's own: git there knows no helper but the two made here, never the real keychain.
      const helpers = await byNetrc.shell({ cmd: "git", args: ["config", "--get-all", "credential.helper"], cwd: root });
      assert.deepEqual(helpers.stdout.trim().split("\n").map((h) => h.replace(/password=\S+;/, "password=…;")), Array(2).fill("!f() { echo username=machine; echo password=…; }; f"));
      let before = priv.seen.length;
      const asked = await run([ask(repoOf(priv))], byNetrc.on(local({})));
      assert.equal(asked.res.status, "success", asked.res.error?.message);
      assert.deepEqual(asked.res.output, { branch: "trunk", head });
      assert.ok(priv.seen.slice(before).some((r) => r.password === TOKEN), "the machine's ~/.netrc");

      // A helper holds it (the global config's here): checkout, and a git+ read, use it.
      const byHelper = await machineWith("helper", { global: TOKEN });
      before = priv.seen.length;
      const checked = await run([step("co", "git/checkout", { repo: repoOf(priv) })], byHelper.on(local({})));
      assert.equal(checked.res.status, "success", checked.res.error?.message);
      await assert.rejects(
        resolvePackage(`git+${repoOf(priv)}@trunk`, { cache: packageCache(join(root, "pkgs-local")), shell: byHelper.shell, dataDir, gitLocal: true }),
        /^Error: package_source_invalid: .*holds no strut\.yaml/,
        "fetched with the machine's helper — and no package there",
      );
      assert.ok(priv.seen.slice(before).some((r) => r.password === TOKEN), "the machine's helper");
    });

    it("with a token for the host, the token wins — and goes to its host alone", async () => {
      // The machine's own would be refused: the run's token is what reads the repository.
      const machine = await machineWith("token");
      let before = priv.seen.length;
      const { res, said } = await run([ask(repoOf(priv))], machine.on(local({ LAB_TOKEN: TOKEN }, [priv])));
      assert.equal(res.status, "success", res.error?.message);
      assert.ok(priv.seen.slice(before).some((r) => r.password === TOKEN));
      assert.deepEqual(machinePasswords(before), [], "none of the machine's beside it");
      assert.ok(!said.includes(TOKEN));

      // A host the token serves sends git on to another: that one gets nothing, the machine's included.
      before = priv.seen.length;
      const movedOn = await run([ask(repoOf(moved))], machine.on(local({ LAB_TOKEN: TOKEN }, [moved])));
      assert.equal(movedOn.res.status, "error");
      assert.ok(priv.seen.length > before, "git followed the redirect");
      assert.deepEqual(priv.seen.slice(before).filter((r) => r.password !== undefined), []);
    });
  });

  describe("a package's step", () => {
    /** What a step of a package sees, and the head it gets through strut's own step. */
    const probe = defineStep({
      type: "acme/code/probe",
      input: z.object({ repo: z.string() }),
      output: z.any(),
      async run(cfg, ctx: StepContext<StrutCapabilities>) {
        const s = ctx.services.secrets;
        const read = await s.get("LAB_TOKEN").then(
          () => "read",
          (e: Error) => e.message,
        );
        const mine = s.git ? await s.git(cfg.repo) : undefined;
        const other = s.git ? await s.git("https://git.elsewhere.test/a/b") : undefined;
        const viaStrut = (await ctx.registry["git/remote-head"]!.run({ repo: cfg.repo, timeoutMs: 30_000 }, ctx)) as { head: string };
        return { git: typeof s.git, read, mine: mine === TOKEN ? "the run's token" : (mine ?? null), other: other ?? null, head: viaStrut.head };
      },
    });
    const fenced = (fence: Fence) => ({ ...registry, "acme/code/probe": fenceStep(probe, fence) }) as StepRegistry;

    it("never sees a token when its package did not say requires.git, and strut's git steps it calls still use the run's", async () => {
      const { res, said } = await run([step("p", "acme/code/probe", { repo: repoOf(priv) })], services({ LAB_TOKEN: TOKEN }, [priv]), fenced({ package: "acme/code", secrets: [] }));
      assert.equal(res.status, "success", res.error?.message);
      const out = res.output as Record<string, unknown>;
      assert.deepEqual([out["git"], out["mine"], out["other"], out["head"]], ["undefined", null, null, head]);
      assert.match(String(out["read"]), /^secret_fenced: acme\/code\/probe came from the package acme\/code, which declares no secrets — it may not read LAB_TOKEN/);
      assert.ok(!said.includes(TOKEN));
    });

    it("can't catch the token by handing strut's git step a shell or http of its own: the run's own carry it", async () => {
      const caught: string[] = [];
      const sneak = defineStep({
        type: "acme/code/sneak",
        input: z.object({ repo: z.string() }),
        output: z.any(),
        async run(cfg, ctx: StepContext<StrutCapabilities>) {
          const shell: StrutCapabilities["shell"] = async (req) => {
            caught.push(JSON.stringify(req.env ?? {}));
            return ctx.services.shell(req);
          };
          const http: StrutCapabilities["http"] = async (url, o) => (caught.push(JSON.stringify(o?.headers ?? {})), ctx.services.http(url, o));
          const mine = { ...ctx, services: { ...ctx.services, shell, http } };
          return ctx.registry["git/remote-head"]!.run({ repo: cfg.repo, timeoutMs: 30_000 }, mine);
        },
      });
      const reg = { ...registry, "acme/code/sneak": fenceStep(sneak, { package: "acme/code", secrets: [] }) } as StepRegistry;
      const { res } = await run([step("s", "acme/code/sneak", { repo: repoOf(priv) })], services({ LAB_TOKEN: TOKEN }, [priv]), reg);
      assert.equal(res.status, "success", res.error?.message);
      assert.deepEqual(res.output, { branch: "trunk", head });
      assert.ok(caught.every((c) => !c.includes(TOKEN)), "the token went through the run's own shell alone");
    });

    it("reads the run's token for a host the box serves when its package says requires.git — none for another, and no other secret", async () => {
      const { res, said } = await run([step("p", "acme/code/probe", { repo: repoOf(priv) })], services({ LAB_TOKEN: TOKEN }, [priv]), fenced({ package: "acme/pods", secrets: [], git: true }));
      assert.equal(res.status, "success", res.error?.message);
      const out = res.output as Record<string, unknown>;
      assert.deepEqual([out["git"], out["mine"], out["other"], out["head"]], ["function", "the run's token", null, head]);
      assert.match(String(out["read"]), /^secret_fenced: /, "by name, still only what it declares");
      assert.ok(!said.includes(TOKEN));
    });
  });
});
