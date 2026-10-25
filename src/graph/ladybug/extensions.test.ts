import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstaller } from "../../audio/download.js";
import { EXTENSION_NAMES, LADYBUG_EXTENSION_PINS, extensionAsset, extensionPlatform, pinnedExtensions, type ExtensionPins } from "./extensions.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = { vector: Buffer.from("vector bytes"), fts: Buffer.from("fts bytes") };
const pins: ExtensionPins = {
  core: "9.9.9",
  version: "9.9.0",
  source: "test",
  baseUrl: "https://mirror.test/ext/",
  platforms: {
    osx_arm64: {
      vector: { sha256: sha(bytes.vector), bytes: bytes.vector.length },
      fts: { sha256: sha(bytes.fts), bytes: bytes.fts.length },
    },
  },
};

/** An installer over a fetch that serves `served` by asset name and counts the requests. */
function fakeInstaller(served: Record<string, Buffer>) {
  const urls: string[] = [];
  const install = createInstaller({
    fetchImpl: (async (url: string) => {
      urls.push(url);
      const body = served[url.split("/").pop()!];
      return body ? new Response(new Uint8Array(body)) : new Response("missing", { status: 404 });
    }) as typeof fetch,
  });
  return { install, urls };
}

describe("ladybug's pinned extensions", () => {
  let dir: string;
  before(() => (dir = mkdtempSync(join(tmpdir(), "strut-lbug-pins-"))));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("names Ladybug's platforms", () => {
    assert.equal(extensionPlatform("darwin", "arm64"), "osx_arm64");
    assert.equal(extensionPlatform("darwin", "x64"), "osx_amd64");
    assert.equal(extensionPlatform("linux", "x64"), "linux_amd64");
    assert.equal(extensionPlatform("linux", "arm64"), "linux_arm64");
    assert.equal(extensionPlatform("win32", "x64"), undefined);
    assert.equal(extensionPlatform("linux", "ia32"), undefined);
  });

  it("downloads each pinned file once, verified, and hands back its path", async () => {
    const modelDir = join(dir, "once");
    const { install, urls } = fakeInstaller({ [extensionAsset("osx_arm64", "vector")]: bytes.vector, [extensionAsset("osx_arm64", "fts")]: bytes.fts });
    // baseUrl given: STRUT_LADYBUG_EXTENSION_URL, when set, would win over the pins'.
    const got = await pinnedExtensions("9.9.9", { pins, platform: "osx_arm64", modelDir, install, baseUrl: pins.baseUrl });
    assert.ok("files" in got);
    for (const name of EXTENSION_NAMES) assert.deepEqual(readFileSync(got.files[name]), bytes[name]);
    assert.deepEqual(urls, ["https://mirror.test/ext/osx_arm64-libvector.lbug_extension", "https://mirror.test/ext/osx_arm64-libfts.lbug_extension"]);
    const again = await pinnedExtensions("9.9.9", { pins, platform: "osx_arm64", modelDir, install, baseUrl: pins.baseUrl });
    assert.deepEqual(again, got);
    assert.equal(urls.length, 2, "the second open reads the cache");
    const mirrored = fakeInstaller({ [extensionAsset("osx_arm64", "vector")]: bytes.vector, [extensionAsset("osx_arm64", "fts")]: bytes.fts });
    await pinnedExtensions("9.9.9", { pins, platform: "osx_arm64", modelDir: join(dir, "mirror"), baseUrl: "https://elsewhere.test/x", install: mirrored.install });
    assert.equal(mirrored.urls[0], "https://elsewhere.test/x/osx_arm64-libvector.lbug_extension");
  });

  it("refuses bytes that are not the pinned ones and keeps none of them", async () => {
    const modelDir = join(dir, "tampered");
    const { install } = fakeInstaller({ [extensionAsset("osx_arm64", "vector")]: Buffer.from("rebuilt upstream"), [extensionAsset("osx_arm64", "fts")]: bytes.fts });
    await assert.rejects(pinnedExtensions("9.9.9", { pins, platform: "osx_arm64", modelDir, install }), /sha256 mismatch for ladybug vector/);
    assert.deepEqual(existsSync(join(modelDir, "ladybug")) ? readdirSync(join(modelDir, "ladybug")) : [], []);
  });

  it("has no pin for another core or a platform without one", async () => {
    const { install, urls } = fakeInstaller({});
    const otherCore = await pinnedExtensions("9.9.10", { pins, platform: "osx_arm64", modelDir: dir, install });
    assert.ok("none" in otherCore && /for ladybug 9\.9\.9, and 9\.9\.10 is loaded/.test(otherCore.none));
    const otherPlatform = await pinnedExtensions("9.9.9", { pins, platform: "linux_arm64", modelDir: dir, install });
    assert.ok("none" in otherPlatform && /no pinned ladybug extensions for linux_arm64/.test(otherPlatform.none));
    assert.deepEqual(urls, []);
  });

  it("pins the installed core, on every platform strut ships a backend for", () => {
    // A bump of @ladybugdb/core without new pins would INSTALL whatever the CDN serves.
    const installed = JSON.parse(readFileSync(join(process.cwd(), "node_modules", "@ladybugdb", "core", "package.json"), "utf-8")).version;
    assert.equal(LADYBUG_EXTENSION_PINS.core, installed, "new pins for the new core: see the comment in extensions.ts");
    assert.deepEqual(Object.keys(LADYBUG_EXTENSION_PINS.platforms).sort(), ["linux_amd64", "linux_arm64", "osx_amd64", "osx_arm64"]);
    for (const [platform, files] of Object.entries(LADYBUG_EXTENSION_PINS.platforms)) {
      for (const name of EXTENSION_NAMES) {
        assert.match(files[name].sha256, /^[0-9a-f]{64}$/, `${platform} ${name}`);
        assert.ok(files[name].bytes > 100_000, `${platform} ${name}`);
      }
    }
  });
});
