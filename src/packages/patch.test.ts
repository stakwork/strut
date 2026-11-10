/**
 * What a package update needs of git, and the patch file
 * (plans/managed-packages.md §1, §2) — src/packages/patch.ts. Skipped
 * where there is no git.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { treeFiles, treeHash } from "../version.js";
import { applyPatch, diffDirs, formatPatch, isBinary, mergeText, mergeTrees, packageGit, parsePatch, patchBody, patchDigest, patchStat, PatchStore } from "./patch.js";

const found = await packageGit();
const git = "path" in found ? found.path : "";
const DIGEST = `sha256:${"ab".repeat(32)}`;

let root: string;
async function tree(name: string, files: Record<string, string | Buffer>): Promise<string> {
  const dir = join(root, name);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}
const read = async (dir: string) => Object.fromEntries(await Promise.all((await treeFiles(dir)).map(async (f) => [f, await readFile(join(dir, f), "utf8")] as const)));

describe("a package update's merge and patch file", { skip: git ? false : "no git here" }, () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-patch-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("merges one text three ways: clean when the changes are apart, markers with the base when they collide", async () => {
    const base = "a\nb\nc\nd\n";
    const clean = await mergeText(git, root, { base, ours: "a\nb here\nc\nd\n", theirs: "a\nb\nc\nd upstream\n" });
    assert.deepEqual(clean, { text: "a\nb here\nc\nd upstream\n", clean: true });
    const both = await mergeText(git, root, { base, ours: "a\nb here\nc\nd\n", theirs: "a\nb upstream\nc\nd\n" });
    assert.equal(both.clean, false);
    assert.match(both.text, /<<<<<<< local\nb here\n\|\|\|\|\|\|\| base\nb\n=======\nb upstream\n>>>>>>> upstream\n/);
    // The same change on both sides is no conflict.
    assert.deepEqual(await mergeText(git, root, { base, ours: "a\nB\nc\nd\n", theirs: "a\nB\nc\nd\n" }), { text: "a\nB\nc\nd\n", clean: true });
  });

  it("merges a directory path by path", async () => {
    const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, n]);
    const base = await tree("t/base", {
      "app.yaml": "title: Issues\n",
      "src/App.tsx": "one\ntwo\nthree\n",
      "src/Only.tsx": "kept\n",
      "src/Gone.tsx": "dropped upstream\n",
      "src/Fight.tsx": "x\n",
      "src/Deleted.tsx": "was here\n",
      "public/logo.png": png(1),
      ".env": "ignored\n",
    });
    const ours = await tree("t/ours", {
      "app.yaml": "title: Issues\n",
      "src/App.tsx": "one here\ntwo\nthree\n",
      "src/Only.tsx": "kept\n",
      "src/Gone.tsx": "dropped upstream\n",
      "src/Fight.tsx": "x here\n",
      "src/Mine.tsx": "added here\n",
      "public/logo.png": png(2),
    });
    const theirs = await tree("t/theirs", {
      "app.yaml": "title: Issues 2\n",
      "src/App.tsx": "one\ntwo\nthree upstream\n",
      "src/Only.tsx": "kept\n",
      "src/Fight.tsx": "x upstream\n",
      "src/Deleted.tsx": "changed upstream\n",
      "src/Theirs.tsx": "added upstream\n",
      "db/002.sql": "create table b;\n",
      "public/logo.png": png(3),
    });
    // `ours` deleted src/Deleted.tsx, which the release changed.
    const out = join(root, "t/out");
    const m = await mergeTrees(git, root, { base, ours, theirs, out });
    assert.deepEqual(m, { conflicts: ["src/Deleted.tsx", "src/Fight.tsx"], tookTheirs: ["public/logo.png"] });
    const merged = await read(out);
    assert.deepEqual(Object.keys(merged), ["app.yaml", "db/002.sql", "public/logo.png", "src/App.tsx", "src/Deleted.tsx", "src/Fight.tsx", "src/Mine.tsx", "src/Only.tsx", "src/Theirs.tsx"]);
    assert.equal(merged["app.yaml"], "title: Issues 2\n", "only the release changed it");
    assert.equal(merged["src/App.tsx"], "one here\ntwo\nthree upstream\n", "both changed it, apart");
    assert.equal(merged["src/Mine.tsx"], "added here\n");
    assert.equal(merged["src/Theirs.tsx"], "added upstream\n");
    assert.equal(merged["src/Gone.tsx"], undefined, "the release dropped it and nobody changed it");
    assert.match(merged["src/Fight.tsx"]!, /<<<<<<< local/);
    assert.deepEqual([...(await readFile(join(out, "public/logo.png")))], [...png(3)], "a binary both changed: the release's");
  });

  it("tells a binary from text", () => {
    assert.equal(isBinary(Buffer.from("héllo\n", "utf8")), false);
    assert.equal(isBinary(Buffer.from([0x68, 0, 0x69])), true);
    assert.equal(isBinary(Buffer.from([0xff, 0xfe, 0x68])), true, "not UTF-8");
  });

  it("round-trips a patch: made from two trees, applied to the first, equal to the second — a binary and a new file with it", async () => {
    const a = { "workflows/sync.yaml": "name: sync\nsteps: []\n", "apps/x/src/H.tsx": "a\nb\nc\n", "apps/x/src/Old.tsx": "gone\n", "apps/x/public/logo.png": Buffer.from([0x89, 0, 1]) };
    const b = { "workflows/sync.yaml": "name: sync\nsteps: []\n", "apps/x/src/H.tsx": "a\nB here\nc\n", "apps/x/src/New.tsx": "new\n", "apps/x/public/logo.png": Buffer.from([0x89, 0, 2, 3]) };
    const layout = join(root, "rt");
    await tree("rt/a", a);
    await tree("rt/b", b);
    const body = await diffDirs(git, layout);
    assert.match(body, /^diff --git a\/apps\/x\/public\/logo\.png b\/apps\/x\/public\/logo\.png\n/);
    const patch = formatPatch({ package: "acme/linear", onto: DIGEST, over: { "apps/x": "h1" } }, body);
    assert.deepEqual(parsePatch(patch), { package: "acme/linear", onto: DIGEST, over: { "apps/x": "h1" } });
    assert.equal(patchBody(patch), body);
    assert.deepEqual(patchStat(patch), { files: 4, added: 2, removed: 2 });

    const target = await tree("rt/target", a);
    await applyPatch(git, target, patch);
    assert.equal(await treeHash(target), await treeHash(join(layout, "b")));
    // The same two trees make no patch.
    await tree("same/a", a);
    await tree("same/b", a);
    assert.equal(await diffDirs(git, join(root, "same")), "");
  });

  it("applies inside a git checkout too: a data folder in a repository is not read as that repository", async () => {
    const repo = join(root, "checkout");
    await mkdir(repo, { recursive: true });
    execFileSync(git, ["init", "-q", repo]);
    await tree("checkout/data/lay/a", { "steps/x.ts": "one\n" });
    await tree("checkout/data/lay/b", { "steps/x.ts": "two\n" });
    const patch = formatPatch({ package: "acme/linear", onto: DIGEST, over: { "steps/x.ts": "h" } }, await diffDirs(git, join(repo, "data/lay")));
    const target = await tree("checkout/data/target", { "steps/x.ts": "one\n" });
    await applyPatch(git, target, patch);
    assert.equal(await readFile(join(target, "steps/x.ts"), "utf8"), "two\n");
  });

  it("refuses a patch that does not apply, and changes nothing", async () => {
    await tree("no/a", { "steps/x.ts": "one\ntwo\n", "steps/y.ts": "y\n" });
    await tree("no/b", { "steps/x.ts": "one\nTWO\n", "steps/y.ts": "Y\n" });
    const patch = formatPatch({ package: "acme/linear", onto: DIGEST, over: { "steps/x.ts": "h" } }, await diffDirs(git, join(root, "no")));
    const target = await tree("no/target", { "steps/x.ts": "something else\n", "steps/y.ts": "y\n" });
    await assert.rejects(applyPatch(git, target, patch), /^Error: patch_rejected: the patch does not apply to the release's files — /);
    assert.equal(await readFile(join(target, "steps/y.ts"), "utf8"), "y\n", "all or nothing");
  });

  it("reads a patch's header, and says what is wrong with one", () => {
    assert.match(parsePatch("diff --git a/x b/x\n") as string, /three lines/);
    assert.match(parsePatch(`package: acme/linear\nonto: v2\nover: a=b\n`) as string, /onto is the digest/);
    assert.match(parsePatch(`package: acme/linear\nonto: ${DIGEST}\nover: nohash\n`) as string, /<path>=<hash>/);
    assert.match(parsePatch(`package: acme/linear\nonto: ${DIGEST}\nover:\n`) as string, /names no fork/);
    // Paths are sorted, so the same patch is the same bytes.
    const one = formatPatch({ package: "p/q", onto: DIGEST, over: { "workflows/b.yaml": "2", "apps/a": "1" } }, "");
    assert.equal(one, `package: p/q\nonto: ${DIGEST}\nover: apps/a=1 workflows/b.yaml=2\n`);
  });

  it("keeps a patch by the sha256 of its bytes", async () => {
    const store = new PatchStore(join(root, "patches"));
    const patch = formatPatch({ package: "acme/linear", onto: DIGEST, over: { "steps/x.ts": "h" } }, "diff --git a/steps/x.ts b/steps/x.ts\n");
    const digest = await store.put(patch);
    assert.equal(digest, patchDigest(patch));
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await store.get(digest), patch);
    assert.equal(await store.get(DIGEST), undefined);
    await assert.rejects(store.put("not a patch"), /^Error: patch_invalid: /);
    await writeFile(join(root, "patches", `${digest.replace(":", "-")}.patch`), `${patch}tampered`);
    await assert.rejects(store.get(digest), /patch_corrupt/);
  });
});
