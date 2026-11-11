/**
 * Packages installed at first boot (`STRUT_PACKAGES`, `createStrut({
 * packages })`) — src/packages/boot.ts.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { bootPackageName, parseBootPackagesEnv } from "./boot.js";

const KEY = "y".repeat(52);
const STEP = `import { z, defineStep } from "strut";
export default defineStep({ type: "acme/desk/hello", input: z.object({}), output: z.any(), async run() { return "hi"; } });
`;
const PACKAGE: Record<string, string> = {
  "strut.yaml": "package: acme/desk\nversion: 1.0.0\nrequires:\n  secrets: [DESK_KEY]\n",
  "steps/hello.ts": STEP,
  "workflows/greet.yaml": "name: acme/desk/greet\nsteps:\n  - { id: s, type: acme/desk/hello }\n",
};

let root: string;
async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = join(root, "pkg");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const boot = (ws: WorkspaceManager, extra: Record<string, unknown> = {}) =>
  createStrut({
    workspace: ws,
    store: new MemoryRunStore(),
    serveUi: false,
    scheduler: false,
    enableChat: false,
    systemWorkflows: false,
    browserWorkflows: false,
    privacyWorkflows: false,
    job: false,
    orchestrator: false,
    builder: false,
    views: false,
    jamie: false,
    knowledge: false,
    concepts: false,
    stt: false,
    subscriptionPoll: false,
    ...extra,
  });

/** Every console.warn / console.log line while `fn` runs. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const { warn, log } = console;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, { warn, log });
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-boot-packages-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("STRUT_PACKAGES", () => {
  it("is nothing unset or empty, and a list of { ref, url?, digest? }", () => {
    assert.deepEqual(parseBootPackagesEnv(undefined), []);
    assert.deepEqual(parseBootPackagesEnv("  "), []);
    assert.deepEqual(parseBootPackagesEnv("[]"), []);
    assert.deepEqual(parseBootPackagesEnv(JSON.stringify([{ ref: "acme/desk" }, { ref: `pk:${KEY}/acme/desk`, url: "https://box.example/packages/catalog?public=1" }])), [
      { ref: "acme/desk" },
      { ref: `pk:${KEY}/acme/desk`, url: "https://box.example/packages/catalog?public=1" },
    ]);
  });

  it("refuses what is not one, naming the entry", () => {
    assert.throws(() => parseBootPackagesEnv("acme/desk"), /STRUT_PACKAGES is not JSON/);
    assert.throws(() => parseBootPackagesEnv('{"ref":"acme/desk"}'), /JSON list/);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"acme/desk"},{}]'), /STRUT_PACKAGES\[1\]: ref is required/);
    assert.throws(() => parseBootPackagesEnv(`[{"ref":"pk:${KEY}/acme/desk"}]`), /needs url/);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"acme/desk","url":"https://x.example/c"}]'), /a url goes with a pk: ref/);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"acme/desk","digest":"sha256:no"}]'), /digest is sha256/);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"git+https://x"}]'), /needs an owner and a name/);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"https://x/a/b"}]'), /a ref is publisher\/name/);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"acme/desk","tokenSecret":"GH"}]'), /tokenSecret goes with a git\+ ref/);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"git+https://github.com/acme/desk@main","tokenSecret":"ghp_x-y"}]'), /NAME of a secret/);
    assert.deepEqual(parseBootPackagesEnv('[{"ref":"git+https://github.com/acme/desk@main#strut","tokenSecret":"DESK_GH"}]'), [{ ref: "git+https://github.com/acme/desk@main#strut", tokenSecret: "DESK_GH" }]);
    assert.throws(() => parseBootPackagesEnv('[{"ref":"acme/desk","channel":"stable"}]'), /unknown field "channel"/);
  });

  it("names a package from its ref without installing it", async () => {
    assert.equal(await bootPackageName("acme/desk"), "acme/desk");
    assert.equal(await bootPackageName(`pk:${KEY}/acme/desk@sha256:${"0".repeat(64)}`), "acme/desk");
    assert.equal(await bootPackageName(`file:${await writeTree(PACKAGE)}`), "acme/desk");
    assert.equal(await bootPackageName(`file:${join(root, "missing")}`), undefined);
  });
});

describe("installing packages at first boot", () => {
  let saved: string | undefined;
  before(() => {
    saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
  });
  after(() => {
    if (saved !== undefined) process.env["STRUT_API_KEY"] = saved;
  });

  it("installs a listed package once, and leaves it alone on the next boot", async () => {
    const dir = await writeTree(PACKAGE);
    const ws = new WorkspaceManager(join(root, "workspace"));
    const first = await capture(async () => {
      const strut = await boot(ws, { packages: [{ ref: `file:${dir}` }] });
      const outcomes = await strut.packages.booted;
      await strut.close();
      return outcomes;
    });
    assert.deepEqual(first.value.map((o) => [o.package, o.status, o.version]), [["acme/desk", "installed", "1.0.0"]]);
    assert.deepEqual(first.value[0]!.missing?.secrets, ["DESK_KEY"]);
    assert.ok(first.lines.some((l) => l.includes("[packages] installed at boot: acme/desk 1.0.0")), first.lines.join("\n"));
    assert.ok(first.lines.some((l) => l.includes("secret DESK_KEY")), first.lines.join("\n"));
    assert.equal((await ws.getWorkflowMetadata("acme/desk/greet"))?.active, "v1");

    // The package changes; a second boot installs nothing, updates nothing.
    await writeFile(join(dir, "workflows/greet.yaml"), PACKAGE["workflows/greet.yaml"]!.replace("id: s", "id: t"));
    const second = await capture(async () => {
      const strut = await boot(ws, { packages: [{ ref: `file:${dir}` }] });
      const outcomes = await strut.packages.booted;
      await strut.close();
      return outcomes;
    });
    assert.deepEqual(second.value.map((o) => [o.package, o.status]), [["acme/desk", "present"]]);
    assert.ok(!second.lines.some((l) => l.includes("installed at boot")), second.lines.join("\n"));
    assert.deepEqual(Object.keys((await ws.getWorkflowMetadata("acme/desk/greet"))?.versions ?? {}), ["v1"]);
  });

  it("boots when a source does not answer, says why, and goes on to the next", async () => {
    const dir = await writeTree(PACKAGE);
    const ws = new WorkspaceManager(join(root, "workspace"));
    const { value, lines } = await capture(async () => {
      const strut = await boot(ws, {
        packages: [{ ref: `pk:${KEY}/acme/legal`, url: "http://127.0.0.1:9/packages/catalog?public=1" }, { ref: `file:${dir}` }],
      });
      const res = await strut.app.request("/health");
      const outcomes = await strut.packages.booted;
      await strut.close();
      return { health: res.status, outcomes };
    });
    assert.equal(value.health, 200);
    assert.deepEqual(value.outcomes.map((o) => [o.package, o.status]), [["acme/legal", "failed"], ["acme/desk", "installed"]]);
    assert.ok(value.outcomes[0]!.error);
    assert.ok(lines.some((l) => l.includes("could not install acme/legal at boot")), lines.join("\n"));
  });

  it("fails the boot on an entry that is not one", async () => {
    const ws = new WorkspaceManager(join(root, "workspace"));
    await assert.rejects(boot(ws, { packages: [{ ref: "acme/desk", url: "https://x.example/c" }] }), /packages\[0\]: .*a url goes with a pk: ref/);
    process.env["STRUT_PACKAGES"] = "acme/desk";
    try {
      await assert.rejects(boot(ws), /STRUT_PACKAGES is not JSON/);
    } finally {
      delete process.env["STRUT_PACKAGES"];
    }
  });

  it("is nothing when none are listed", async () => {
    const strut = await boot(new WorkspaceManager(join(root, "workspace")));
    assert.deepEqual(await strut.packages.booted, []);
    await strut.close();
  });
});
