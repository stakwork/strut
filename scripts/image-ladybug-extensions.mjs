#!/usr/bin/env node
/**
 * Ladybug's `vector` + `fts` extensions, carried in the Docker image so the
 * graph backend opens with no download (src/graph/ladybug/extensions.ts):
 *
 *   node scripts/image-ladybug-extensions.mjs stage <dir>
 *   node scripts/image-ladybug-extensions.mjs check
 *
 * `stage` fetches the PINNED bytes for the installed core on this machine's
 * platform — the image's target arch, under QEMU for arm64 — through the
 * server's own loader (`pinnedExtensions`: sha256-verified), and copies them
 * flat into <dir>, which the Dockerfile names in STRUT_LADYBUG_EXTENSION_DIR.
 * A core or platform without a pin fails the build. The desktop package does
 * the same into native/ (scripts/package-desktop.mjs).
 *
 * `check` opens a temp graph through `openLadybug` — what the workspace graph
 * does at boot: LOAD both extensions from STRUT_LADYBUG_EXTENSION_DIR, then
 * build the FTS and vector indexes — and fails unless both are loaded. The
 * Dockerfile runs it with `RUN --network=none`, so a load that would reach
 * for the network fails the image build on every platform.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = (p) => import(pathToFileURL(join(ROOT, "build", "graph", "ladybug", p)).href);
const fail = (m) => {
  console.error(`[ladybug-extensions] FAILED: ${m}`);
  process.exit(1);
};

const [mode, dest] = process.argv.slice(2);
const { EXTENSION_NAMES } = await built("extensions.js");

if (mode === "stage") {
  if (!dest) fail("usage: stage <dir>");
  const { LADYBUG_EXTENSION_PINS: pins, pinnedExtensions, extensionPlatform } = await built("extensions.js");
  const lbug = (await import("@ladybugdb/core")).default;
  const cache = await mkdtemp(join(tmpdir(), "strut-lbug-ext-"));
  const got = await pinnedExtensions(lbug.Database.getVersion(), { modelDir: cache });
  if ("none" in got) fail(`${got.none}: pin the extensions (src/graph/ladybug/extensions.ts) before building the image`);
  await mkdir(dest, { recursive: true });
  for (const name of EXTENSION_NAMES) await copyFile(got.files[name], join(dest, `lib${name}.lbug_extension`));
  await rm(cache, { recursive: true, force: true });
  console.log(`[ladybug-extensions] staged ${EXTENSION_NAMES.join(" + ")} ${pins.version} (${extensionPlatform()}, pinned) → ${dest}`);
} else if (mode === "check") {
  if (!process.env.STRUT_LADYBUG_EXTENSION_DIR) fail("STRUT_LADYBUG_EXTENSION_DIR is not set");
  const { openLadybug } = await built("db.js");
  const tmp = await mkdtemp(join(tmpdir(), "strut-lbug-check-"));
  const handle = await openLadybug(join(tmp, "graph", "graph.lbug")).catch((err) => fail(err instanceof Error ? err.message : String(err)));
  const ro = await handle.readOnly();
  const loaded = (await ro.query("CALL SHOW_LOADED_EXTENSIONS() RETURN *")).map((r) => JSON.stringify(r).toLowerCase());
  await ro.close();
  await handle.close();
  await rm(tmp, { recursive: true, force: true });
  const missing = EXTENSION_NAMES.filter((name) => !loaded.some((r) => r.includes(name)));
  if (missing.length) fail(`not loaded: ${missing.join(", ")} (SHOW_LOADED_EXTENSIONS: ${loaded.join("; ")})`);
  console.log(`[ladybug-extensions] OK — the graph opens with ${EXTENSION_NAMES.join(" + ")} from ${process.env.STRUT_LADYBUG_EXTENSION_DIR}, no network`);
} else {
  fail(`unknown mode ${mode ?? "(none)"}: stage <dir> | check`);
}
