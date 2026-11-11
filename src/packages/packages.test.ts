import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { tar } from "../tar.js";
import { treeHash } from "../version.js";
import { WorkspaceManager } from "../workspace.js";
import { archiveProblem, archiveUrl, fetchArchive, MAX_ARCHIVE_FILES, packArchive } from "./archive.js";
import { packageCache, resolvePackage } from "./cache.js";
import { pathProblems, readPackage } from "./format.js";

const PACKAGE: Record<string, string> = {
  "strut.yaml": "package: acme/linear\nversion: 1.4.0\ndescription: Linear issues\nrequires:\n  secrets: [LINEAR_API_KEY]\n",
  "README.md": "# acme/linear\n",
  "workflows/sync.yaml": "name: acme/linear/sync\nsteps:\n  - id: say\n    type: log\n    config: { message: hi }\n",
  "workflows/admin/backfill.yaml": "name: acme/linear/admin/backfill\nsteps: []\n",
  "steps/create-issue.ts": 'export default { type: "acme/linear/create-issue" };\n',
  "steps/create-issue.claims.yaml": "- claim: it creates one issue\n",
  "steps/_shared.ts": "export const x = 1;\n",
  "concepts/Linear.md": "---\ndescription: Linear\n---\nThe tracker.\n",
  "apps/issues/app.yaml": "title: Issues\n",
  "apps/issues/src/App.tsx": "export default function App() { return null; }\n",
};

async function writeTree(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-pkg-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const pkgDir = (files: Record<string, string> = PACKAGE, name = "src") => writeTree(join(root, name, randomUUID()), files);

describe("readPackage", () => {
  it("names every item under the prefix and hashes the whole tree", async () => {
    const info = await readPackage(await pkgDir());
    assert.equal(info.manifest.package, "acme/linear");
    assert.deepEqual(info.manifest.requires?.secrets, ["LINEAR_API_KEY"]);
    assert.match(info.digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(info.files, Object.keys(PACKAGE).sort());
    assert.deepEqual(
      info.items.map((i) => [i.kind, i.name, i.path, i.helper ?? false, i.claims ?? ""]),
      [
        ["app", "acme/linear/issues", "apps/issues", false, ""],
        ["concept", "Linear", "concepts/Linear.md", false, ""],
        ["step", "acme/linear/_shared", "steps/_shared.ts", true, ""],
        ["step", "acme/linear/create-issue", "steps/create-issue.ts", false, "steps/create-issue.claims.yaml"],
        ["workflow", "acme/linear/admin/backfill", "workflows/admin/backfill.yaml", false, ""],
        ["workflow", "acme/linear/sync", "workflows/sync.yaml", false, ""],
      ],
    );
  });

  it("a byte anywhere moves the digest, strut.yaml included; what it leaves out does not", async () => {
    const base = (await readPackage(await pkgDir())).digest;
    assert.equal((await readPackage(await pkgDir())).digest, base, "the digest is the content, not the place");
    const edited = (await readPackage(await pkgDir({ ...PACKAGE, "steps/_shared.ts": "export const x = 2;\n" }))).digest;
    assert.notEqual(edited, base);
    const relabeled = (await readPackage(await pkgDir({ ...PACKAGE, "strut.yaml": PACKAGE["strut.yaml"]!.replace("1.4.0", "1.4.1") }))).digest;
    assert.notEqual(relabeled, base);
    const noisy = await pkgDir({
      ...PACKAGE,
      ".git/HEAD": "ref: main\n",
      "steps/.DS_Store": "x",
      "node_modules/x/index.js": "x",
      "apps/issues/dist/index.html": "<html>",
      "apps/issues/data.db": "rows",
    });
    assert.equal((await readPackage(noisy)).digest, base);
  });

  it("an app is hashed as its own version hash hashes it", async () => {
    const dir = await pkgDir({ ...PACKAGE, "apps/issues/dist/index.html": "<html>", "apps/issues/.cache": "x" });
    const plain = await pkgDir({ "app.yaml": PACKAGE["apps/issues/app.yaml"]!, "src/App.tsx": PACKAGE["apps/issues/src/App.tsx"]! });
    assert.equal(await treeHash(join(dir, "apps", "issues")), await treeHash(plain));
  });

  it("refuses what it cannot install whole, naming every problem", async () => {
    const bad = async (files: Record<string, string>, re: RegExp) =>
      assert.rejects(readPackage(await pkgDir(files)), (err: Error) => {
        assert.match(err.message, /^bad_package: /);
        assert.match(err.message, re);
        return true;
      });
    const { "strut.yaml": _m, ...noManifest } = PACKAGE;
    await bad(noManifest, /no strut\.yaml/);
    await bad({ ...PACKAGE, "prompts/a.txt": "x", "prompts/b.txt": "y", "hotwords/c.txt": "z" }, /hotwords\/ is not a folder this strut server knows.*; prompts\/ is not/);
    await bad({ ...PACKAGE, "workflows/sync.json": "{}" }, /workflows\/sync\.json: a workflow is a \.yaml file/);
    await bad({ ...PACKAGE, "workflows/runs/x.yaml": "steps: []" }, /Invalid workflow name "acme\/linear\/runs\/x": "runs" is reserved/);
    await bad({ ...PACKAGE, "workflows/each#2.yaml": "steps: []" }, /Invalid workflow name "acme\/linear\/each#2": "#" is not allowed/);
    await bad({ ...PACKAGE, "steps/notes.md": "x" }, /steps\/notes\.md: a step is a \.ts file/);
    await bad({ ...PACKAGE, "steps/create.test.ts": "x" }, /Invalid step name "acme\/linear\/create\.test"/);
    await bad({ ...PACKAGE, "steps/orphan.claims.yaml": "[]", "steps/_shared.claims.yaml": "[]" }, /_shared\.claims\.yaml: a `_` file is a helper, not a step.*orphan\.claims\.yaml: claims belong beside the step they are about, steps\/orphan\.ts/);
    await bad({ ...PACKAGE, "concepts/sub/A.md": "x" }, /a Concept is a page/);
    await bad({ ...PACKAGE, "concepts/linear-again.md": "---\nname: Linear\n---\nAgain.\n" }, /concepts\/linear-again\.md: the Concept Linear is concepts\/Linear\.md too/);
    await bad({ ...PACKAGE, "concepts/a.md": "---\nname: Law\n---\nx\n", "concepts/b.md": "---\nname: Law\n---\ny\n" }, /the Concept Law is concepts\/a\.md too/);
    await bad({ ...PACKAGE, "concepts/n.md": "---\nname: 2024\n---\nx\n" }, /concepts\/n\.md: a page's name is a string/);
    await bad({ ...PACKAGE, "concepts/p.md": "---\nname: P\nparents: [{ a: 1 }]\n---\nx\n" }, /parents is a list of Concept names/);
    await bad({ ...PACKAGE, "apps/loose.txt": "x" }, /an app is a folder/);
    await bad({ ...PACKAGE, "apps/empty/src/a.ts": "x" }, /apps\/empty\/: an app's folder holds its app\.yaml/);
    await bad({ ...PACKAGE, "apps/v2/app.yaml": "title: x" }, /version label/);
    await bad({ "strut.yaml": PACKAGE["strut.yaml"]!, "README.md": "x" }, /no items/);
  });

  it("names a Concept page by the name in its front matter whatever its file (the new form), and by its file in the old form", async () => {
    const info = await readPackage(
      await pkgDir({ ...PACKAGE, "concepts/Explore.md": "---\nname: acme/linear\nparents: [Linear]\n---\nIts code.\n", "concepts/concept-law.md": "---\nname: Law\n---\nAll of it.\n" }),
    );
    assert.deepEqual(
      info.items.filter((i) => i.kind === "concept").map((i) => [i.name, i.path]),
      [["acme/linear", "concepts/Explore.md"], ["Linear", "concepts/Linear.md"], ["Law", "concepts/concept-law.md"]],
    );
  });

  it("refuses a manifest it does not know, line by line", async () => {
    const manifest = (text: string) => pkgDir({ ...PACKAGE, "strut.yaml": text });
    await assert.rejects(readPackage(await manifest("package: Acme/Linear\nversion: '1'\n")), /strut\.yaml: package: a package is named publisher\/name/);
    await assert.rejects(readPackage(await manifest("package: acme\nversion: '1'\n")), /publisher\/name/);
    await assert.rejects(readPackage(await manifest("package: acme/linear/x\nversion: '1'\n")), /publisher\/name/);
    await assert.rejects(readPackage(await manifest("package: acme/linear\nversion: 1.4\n")), /strut\.yaml: version: /);
    await assert.rejects(readPackage(await manifest("package: acme/linear\nversion: '1'\nprice: 5\n")), /price/);
    await assert.rejects(
      readPackage(await manifest("package: acme/linear\nversion: '1'\nrequires:\n  packages:\n    - { package: bob/util, digest: sha256:abc, source: file:/x }\n")),
      /requires\.packages\[0\]\.digest: a digest is sha256/,
    );
    const self = `package: acme/linear\nversion: '1'\nrequires:\n  packages:\n    - { package: acme/linear, digest: "sha256:${"0".repeat(64)}", source: file:/x }\n`;
    await assert.rejects(readPackage(await manifest(self)), /requires itself/);
    await assert.rejects(readPackage(await manifest("package: [\n")), /not valid YAML/);
  });

  it("takes an optional license line, as written, and it is under the digest", async () => {
    const manifest = (text: string) => pkgDir({ ...PACKAGE, "strut.yaml": text });
    const without = await readPackage(await manifest("package: acme/linear\nversion: '1'\n"));
    assert.equal(without.manifest.license, undefined);
    const licensed = await readPackage(await manifest("package: acme/linear\nversion: '1'\nlicense: MIT OR Apache-2.0\n"));
    assert.equal(licensed.manifest.license, "MIT OR Apache-2.0");
    assert.notEqual(licensed.digest, without.digest);
    await assert.rejects(readPackage(await manifest("package: acme/linear\nversion: '1'\nlicense: ''\n")), /strut\.yaml: license: a license is an SPDX expression/);
    await assert.rejects(readPackage(await manifest("package: acme/linear\nversion: '1'\nlicense: 5\n")), /strut\.yaml: license: /);
  });

  it("refuses a symlink", async () => {
    const dir = await pkgDir();
    await symlink("/etc/passwd", join(dir, "steps", "leak.ts"));
    await assert.rejects(readPackage(dir), /steps\/leak\.ts is not a regular file/);
  });
});

describe("a package's names", () => {
  const CLASH = "differ only in letter case, which a Mac or Windows holds as one name — rename one";

  it("land as themselves on every machine: no two one in letter case, none Windows cannot hold, every one in Unicode NFC", () => {
    assert.deepEqual(pathProblems(Object.keys(PACKAGE)), []);
    // A file, then a folder: the second spelling is named once, however
    // many files sit under it.
    assert.deepEqual(pathProblems(["workflows/sync.yaml", "workflows/Sync.yaml", "workflows/SYNC.yaml"]), [`workflows/sync.yaml and workflows/Sync.yaml ${CLASH}`]);
    assert.deepEqual(pathProblems(["workflows/Admin/a.yaml", "workflows/admin/b.yaml", "workflows/admin/c.yaml"]), [`workflows/Admin/ and workflows/admin/ ${CLASH}`]);
    // Composed is one spelling everywhere; a letter plus a combining accent is not.
    assert.deepEqual(pathProblems(["concepts/café.md"]), []);
    assert.deepEqual(pathProblems(["workflows/console.yaml", "workflows/com10.yaml", "workflows/nullable.yaml"]), [], "a device's name inside a longer one is fine");
    const problems = pathProblems([
      "concepts/café.md",
      "workflows/a:b.yaml",
      "workflows/con.yaml",
      "workflows/Lpt1",
      "workflows/v1./x.yaml",
      "workflows/tab\there.yaml",
      "workflows/ok.yaml",
    ]);
    assert.equal(problems.length, 6, problems.join("\n"));
    assert.match(problems[0]!, /^concepts\/café\.md: spells an accented letter as a letter plus a separate accent \(not Unicode NFC\)/);
    assert.equal(problems[1], 'workflows/a:b.yaml: holds ":", which Windows does not allow in a file name');
    assert.equal(problems[2], "workflows/con.yaml: is CON, a name Windows keeps for a device");
    assert.equal(problems[3], "workflows/Lpt1: is LPT1, a name Windows keeps for a device");
    assert.equal(problems[4], "workflows/v1./: ends in a dot or a space, which Windows drops from a file name");
    assert.equal(problems[5], "workflows/tab\there.yaml: holds a control character");
  });

  it("are refused by readPackage, and a clash too where the disk keeps letter case", async () => {
    await assert.rejects(readPackage(await pkgDir({ ...PACKAGE, "workflows/a:b.yaml": "steps: []\n" })), /^Error: bad_package: workflows\/a:b\.yaml: holds ":", which Windows does not allow/);
    const probe = await pkgDir({ "x.txt": "" });
    if (existsSync(join(probe, "X.txt"))) return; // a Mac's disk: it cannot hold the pair, and archives and git trees are checked before writing
    await assert.rejects(readPackage(await pkgDir({ ...PACKAGE, "workflows/Sync.yaml": "steps: []\n" })), new RegExp(`workflows/Sync\\.yaml and workflows/sync\\.yaml ${CLASH}`));
  });
});

describe("the package cache", () => {
  it("resolves file: into one directory per digest, once", async () => {
    const cache = packageCache(join(root, "data"));
    const src = await pkgDir();
    const first = await resolvePackage(`file:${src}`, { cache });
    assert.equal(first.dir, join(root, "data", "packages", first.digest.replace(":", "-")));
    assert.deepEqual(first.source, { ref: `file:${src}` });
    assert.equal((await readPackage(first.dir)).digest, first.digest);
    const again = await resolvePackage(`file://${src}`, { cache, digest: first.digest });
    assert.equal(again.dir, first.dir);
    assert.deepEqual(readdirSync(join(root, "data", "packages")).filter((n) => !n.startsWith(".")), [first.digest.replace(":", "-")]);
    assert.deepEqual(readdirSync(join(root, "data", "packages", ".scratch")), [], "no scratch left behind");
  });

  it("refuses a pin the tree is not, and keeps nothing", async () => {
    const cache = packageCache(join(root, "data"));
    const pin = `sha256:${"a".repeat(64)}`;
    await assert.rejects(resolvePackage(`file:${await pkgDir()}`, { cache, digest: pin }), /^Error: package_digest_mismatch: expected sha256:a+, the tree is sha256:/);
    assert.equal(existsSync(cache.dirOf(pin)), false);
  });

  it("takes a relative file: ref only against a base, and names a ref that is not one", async () => {
    const cache = packageCache(join(root, "data"));
    await pkgDir(PACKAGE, "distro/packages/acme");
    const [id] = readdirSync(join(root, "distro", "packages", "acme"));
    await assert.rejects(resolvePackage(`file:packages/acme/${id}`, { cache }), /package_source_invalid: .*an absolute path/);
    const rel = await resolvePackage(`file:packages/acme/${id}`, { cache, base: join(root, "distro") });
    assert.equal(rel.manifest.package, "acme/linear");
    await assert.rejects(resolvePackage(`file:${join(root, "nope")}`, { cache }), /package_source_invalid: .*no directory/);
    await assert.rejects(resolvePackage("git+https://github.com/acme/linear@", { cache }), /package_source_invalid: .*nothing after @/);
    await assert.rejects(resolvePackage("git+ssh://github.com/acme/linear@v1", { cache }), /package_source_invalid: .*a token cannot authenticate an ssh remote/);
    await assert.rejects(resolvePackage(`pk:${"y".repeat(52)}/acme/linear`, { cache }), /package_source_invalid: .*a pk: ref needs url/);
    await assert.rejects(resolvePackage("https://example.com/x.tar.gz", { cache }), /package_source_invalid: .*starts with file:, git\+ or pk:/);
  });

  it("an archive lands only as the tree its digest names", async () => {
    const cache = packageCache(join(root, "data"));
    const src = await readPackage(await pkgDir());
    const gz = await packArchive((await resolvePackage(`file:${await pkgDir()}`, { cache: packageCache(join(root, "other")) })).dir, src.files);
    const landed = await cache.putArchive(gz, src.digest);
    assert.equal(landed.digest, src.digest);
    assert.deepEqual(landed.items, src.items);

    const fresh = packageCache(join(root, "fresh"));
    await assert.rejects(fresh.putArchive(gz, `sha256:${"b".repeat(64)}`), /package_digest_mismatch/);
    const entries = (extra: [string, string]) =>
      gzipSync(tar([...Object.entries(PACKAGE), extra].map(([n, t]) => [n, Buffer.from(t)] as [string, Buffer])));
    await assert.rejects(fresh.putArchive(entries(["../evil.ts", "x"]), src.digest), /"\.\.\/evil\.ts" is not a relative path/);
    await assert.rejects(fresh.putArchive(entries(["/etc/evil", "x"]), src.digest), /is not a relative path/);
    await assert.rejects(fresh.putArchive(entries([".git/config", "x"]), src.digest), /"\.git\/config" is a path a package digest never covers/);
    await assert.rejects(fresh.putArchive(entries(["apps/issues/dist/a.js", "x"]), src.digest), /never covers/);
    // A name only a PAX header holds is checked whole.
    const longEvil = `steps/${"x".repeat(120)}/${"../".repeat(30)}evil.ts`;
    await assert.rejects(fresh.putArchive(entries([longEvil, "x"]), src.digest), /is not a relative path/);
    await assert.rejects(fresh.putArchive(entries([`concepts/${"y".repeat(150)}/.git/config`, "x"]), src.digest), /never covers/);
    await assert.rejects(fresh.putArchive(Buffer.from("not gzip"), src.digest), /bad_package: not a package archive/);
    // Two names one in letter case: refused before a file is written, so a
    // Mac's disk never merges them into a tree that hashes to something else.
    await assert.rejects(
      fresh.putArchive(entries(["workflows/Sync.yaml", "steps: []\n"]), src.digest),
      /^Error: bad_package: workflows\/sync\.yaml and workflows\/Sync\.yaml differ only in letter case/,
    );
    assert.deepEqual(readdirSync(fresh.root).filter((n) => !n.startsWith(".")), [], "nothing kept from a refused archive");
    assert.equal(existsSync(join(root, "fresh", "evil.ts")) || existsSync(join(root, "evil.ts")), false);
  });
});

describe("a build's archive check", () => {
  it("says nothing of a package that travels, and what is past an archive's caps", async () => {
    const dir = join(tmpdir(), `strut-archive-check-${randomUUID()}`);
    try {
      await mkdir(join(dir, "concepts"), { recursive: true });
      await writeFile(join(dir, "strut.yaml"), "package: acme/notes\nversion: '1'\n");
      await writeFile(join(dir, "concepts", `concept-${"z".repeat(200)}.md`), "---\nname: Z\n---\n");
      const files = (await readPackage(dir)).files;
      assert.equal(await archiveProblem(dir, files), undefined, "a long name travels");
      const many = Array.from({ length: MAX_ARCHIVE_FILES + 1 }, (_, i) => `steps/f${i}.ts`);
      assert.match((await archiveProblem(dir, many))!, new RegExp(`holds ${MAX_ARCHIVE_FILES + 1} files, more than the ${MAX_ARCHIVE_FILES}`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the archive route and fetchArchive", () => {
  const KEY = "pkg-key";
  let saved: string | undefined;
  let a: Strut;
  let b: Strut;
  let digest: string;
  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
  });
  after(() => {
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
  });
  const boot = (name: string) =>
    createStrut({
      workspace: new WorkspaceManager(join(root, name)),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      views: false,
    });
  beforeEach(async () => {
    a = await boot("a");
    b = await boot("b");
    digest = (await resolvePackage(`file:${await pkgDir()}`, { cache: packageCache(a.dataDir) })).digest;
  });
  afterEach(async () => {
    delete process.env["STRUT_API_KEY"];
    await a.close?.();
    await b.close?.();
  });
  /** strut A's app as the network: what B's fetch reaches. */
  const network = (serve = a) => ((url: string | URL | Request, init?: RequestInit) => serve.app.request(String(url), init)) as typeof fetch;
  const url = (pkg = "acme/linear", d = digest) => archiveUrl("http://a.test", pkg, d);

  it("serves a cached package by digest, as an immutable tar.gz", async () => {
    const res = await a.app.request(url());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/gzip");
    assert.equal(res.headers.get("etag"), `"${digest}"`);
    assert.match(res.headers.get("cache-control")!, /immutable/);
    assert.match(res.headers.get("content-disposition")!, /acme-linear-[0-9a-f]{12}\.tar\.gz/);
    const unpacked = await packageCache(join(root, "check")).putArchive(Buffer.from(await res.arrayBuffer()), digest);
    assert.equal(unpacked.digest, digest);
    assert.equal((await a.app.request(url(), { headers: { "if-none-match": `"${digest}"` } })).status, 304);
  });

  it("answers only for the package that digest is", async () => {
    assert.equal((await a.app.request(url("acme/other"))).status, 404);
    assert.equal((await a.app.request(url("acme/linear", `sha256:${"c".repeat(64)}`))).status, 404);
    assert.equal((await a.app.request("/packages/acme/linear/archive")).status, 400);
    assert.equal((await a.app.request("/packages/acme/linear/archive?digest=sha256:short")).status, 400);
  });

  it("is behind the key, and fetchArchive carries the caller's credential", async () => {
    process.env["STRUT_API_KEY"] = KEY;
    assert.equal((await a.app.request(url())).status, 401);
    const cache = packageCache(b.dataDir);
    await assert.rejects(fetchArchive({ urls: [url()], digest, cache, fetch: network() }), /package_fetch_failed: .*http:\/\/a\.test\/packages\/acme\/linear\/archive: HTTP 401/);
    const got = await fetchArchive({ urls: [url()], digest, cache, package: "acme/linear", headers: { authorization: `Bearer ${KEY}` }, fetch: network() });
    assert.equal(got.digest, digest);
    assert.equal(got.url, url());
    assert.equal(got.dir, cache.dirOf(digest));
  });

  it("passes over a URL that fails or lies, and B serves what it fetched as a mirror", async () => {
    const liar = (async () => new Response(gzipSync(tar([["strut.yaml", Buffer.from("package: acme/linear\nversion: '9'\n")], ["steps/x.ts", Buffer.from("x")]])))) as typeof fetch;
    const routed = (async (u: string | URL | Request, init?: RequestInit) =>
      String(u).startsWith("http://liar.test") ? liar(u, init) : String(u).startsWith("http://down.test") ? Promise.reject(new Error("ECONNREFUSED")) : network()(u, init)) as typeof fetch;
    const cache = packageCache(b.dataDir);
    const got = await fetchArchive({
      urls: [`http://down.test/x?t=secret-token`, archiveUrl("http://liar.test", "acme/linear", digest), "ftp://old.test/x", url()],
      digest,
      cache,
      fetch: routed,
    });
    assert.equal(got.url, url());
    const again = await fetchArchive({ urls: [], digest, cache, fetch: (() => assert.fail("a cached digest fetches nothing")) as typeof fetch });
    assert.equal(again.dir, got.dir);
    const mirrored = await b.app.request(url());
    assert.equal(mirrored.status, 200, "a strut serves every package its cache holds");
  });

  it("names every URL it tried, and never a query", async () => {
    const err = await fetchArchive({
      urls: [`http://down.test/x?t=secret-token`, archiveUrl("http://a.test", "acme/linear", `sha256:${"d".repeat(64)}`), "not a url"],
      digest: `sha256:${"d".repeat(64)}`,
      cache: packageCache(b.dataDir),
      fetch: (async (u: string | URL | Request, init?: RequestInit) => (String(u).startsWith("http://down.test") ? Promise.reject(new Error("ECONNREFUSED")) : network()(u, init))) as typeof fetch,
    }).catch((e: Error) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /^package_fetch_failed: sha256:d+: http:\/\/down\.test\/x: ECONNREFUSED; http:\/\/a\.test\/packages\/acme\/linear\/archive: HTTP 404; not a url: /);
    assert.doesNotMatch(err.message, /secret-token/);
    await assert.rejects(fetchArchive({ urls: [], digest, cache: packageCache(b.dataDir) }), /no URL to fetch it from/);
  });

  it("refuses a digest that is another package than the caller expects", async () => {
    await assert.rejects(
      fetchArchive({ urls: [url()], digest, cache: packageCache(b.dataDir), package: "acme/other", fetch: network() }),
      /package_name_mismatch: sha256:[0-9a-f]+ is the package acme\/linear, not acme\/other/,
    );
  });
});
