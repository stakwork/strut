#!/usr/bin/env node
/**
 * Desktop launcher — strut with the defaults a native host (or someone who
 * just downloaded the tarball) wants, with no env to set
 * (plans/local-desktop-and-stt.md §2.5). Staged beside `build/` by
 * `package:desktop`; a host spawns `node desktop.js` and reads one stdout line:
 *
 *   {"event":"ready","port":51234,"host":"127.0.0.1","key":"…"}
 *
 * Defaults (each one an env override): the workspace on one LadybugDB file
 * when the package carries Ladybug and its two extensions in native/
 * (plans/ladybug-backend.md §7.1: `desktop.json`, written by
 * package-desktop.mjs, says what was staged — a filesystem workspace the
 * package finds under the data dir is imported into the file at the first
 * boot), else the filesystem workspace; the graph's embedder on only when
 * the embeddings stack came along; the app build's esbuild binary from
 * native/ (ESBUILD_BINARY_PATH); bind 127.0.0.1 on an OS-picked port;
 * workspace under the platform app-support dir, models under the platform
 * cache dir, a random API key per launch. `--open` launches the web UI in
 * the default browser, which has dictation built in — the quickest way to
 * try the recognizer.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// strut needs Node 22, and workspace custom steps are .ts files loaded by
// Node's own type stripping (on by default from 22.18; earlier 22.x only
// with --experimental-strip-types).
if (Number(process.versions.node.split(".")[0]) < 22 || !process.features.typescript) {
  console.error(
    `strut: Node ${process.version} can't run strut: 22.18 or newer required (type stripping ${process.features.typescript === false ? "off" : "unavailable"})`,
  );
  process.exit(1);
}

if (args[0] !== "move" && (args.includes("--help") || args.includes("-h"))) {
  console.log(`usage: strut [--open]
       strut move <check|send|serve|fetch> …   (strut move --help)

Runs strut locally with desktop defaults. Prints a JSON ready line on stdout
({"event":"ready","port","host","key"}) and the UI URL on stderr.

  --open   open the web UI in the default browser

Env overrides (all optional): STRUT_WORKSPACE, STRUT_CACHE_DIR, STRUT_API_KEY,
STRUT_HOST, STRUT_PORT, STRUT_WORKSPACE_BACKEND (ladybug when the package
carries it, else fs), STRUT_GRAPH_DB, STRUT_LADYBUG_EXTENSION_DIR,
STRUT_GRAPH_EMBEDDINGS, STRUT_SECRET_KEY, STRUT_STT_MODEL,
STRUT_STT_PARTIAL_MODEL, ESBUILD_BINARY_PATH (native/esbuild when the
package carries it), ANTHROPIC_API_KEY.

STRUT_EXIT_ON_STDIN_EOF=1 exits when stdin closes: a host that spawns strut
with a stdin pipe it never writes to gets it shut down when the host dies,
crash or force quit included (the kernel closes the pipe).`);
  process.exit(0);
}

const env = process.env;
const home = homedir();
const os = platform();
const dflt = (k, v) => {
  if (env[k] === undefined || env[k] === "") env[k] = v;
};
const appSupport =
  os === "darwin"
    ? join(home, "Library", "Application Support")
    : os === "win32"
      ? env["APPDATA"] || join(home, "AppData", "Roaming")
      : env["XDG_DATA_HOME"] || join(home, ".local", "share");
const cacheRoot =
  os === "darwin"
    ? join(home, "Library", "Caches")
    : os === "win32"
      ? env["LOCALAPPDATA"] || join(home, "AppData", "Local")
      : env["XDG_CACHE_HOME"] || join(home, ".cache");

// What package-desktop.mjs staged (absent when run from a checkout: fs).
let staged = {};
try {
  staged = JSON.parse(readFileSync(join(here, "desktop.json"), "utf-8"));
} catch {
  /* no manifest: a checkout, not a package */
}
const nativeDir = join(here, "native");
const ladybug =
  staged.ladybug === true &&
  ["lbugjs.node", "libvector.lbug_extension", "libfts.lbug_extension"].every((f) => existsSync(join(nativeDir, f)));
dflt("STRUT_WORKSPACE_BACKEND", ladybug ? "ladybug" : "fs");
if (ladybug) {
  // The graph backend REQUIRES both extensions (ruling 4); the package's
  // copies, never a download — a notarised app cannot fetch them.
  dflt("STRUT_LADYBUG_EXTENSION_DIR", nativeDir);
  // Without the embeddings stack (package:desktop --embeddings) the graph is
  // fulltext-only; the default would try to load MiniLM and fail the boot.
  if (!staged.embeddings) dflt("STRUT_GRAPH_EMBEDDINGS", "off");
}
// The app build's esbuild: package-desktop.mjs moves its binary into native/
// (relocateEsbuild), out of the @esbuild/<platform> package esbuild looks in.
const esbuildBin = join(nativeDir, os === "win32" ? "esbuild.exe" : "esbuild");
if (existsSync(esbuildBin)) dflt("ESBUILD_BINARY_PATH", esbuildBin);
dflt("STRUT_HOST", "127.0.0.1");
dflt("STRUT_PORT", "0");
dflt("STRUT_WORKSPACE", join(appSupport, "strut", "workspace"));
dflt("STRUT_CACHE_DIR", cacheRoot); // models land at <cacheRoot>/strut/models
dflt("STRUT_WEB_DIST", join(here, "web", "dist"));
dflt("STRUT_API_KEY", randomBytes(24).toString("hex"));
env["STRUT_READY_KEY"] = "1"; // put the key on the ready line for the host

// `strut move …` (AGENTS.md, "Moving strut to another host"): over the
// stopped strut's folders, with the defaults above (STRUT_WORKSPACE), and
// no server.
if (args[0] === "move") {
  const { main } = await import("./build/move/cli.js");
  process.exit(await main(args.slice(1)));
}

// Every way out closes the graph file first: a process that exits with it
// open leaves a WAL Ladybug cannot recover its full-text index from.
let leaving = false;
const leave = async (why) => {
  if (leaving) return;
  leaving = true;
  console.error(`strut: ${why}, exiting`);
  // A close that hangs must not keep a host waiting (it SIGKILLs after seconds).
  setTimeout(() => process.exit(0), 1500).unref();
  try {
    const { closeAllLadybug } = await import("./build/graph/ladybug/db.js");
    await closeAllLadybug();
  } catch (err) {
    console.error("strut: closing the graph failed:", err);
  }
  process.exit(0);
};
// A second signal while closing is the person insisting.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => (leaving ? process.exit(0) : void leave(sig)));

if (env["STRUT_EXIT_ON_STDIN_EOF"] === "1") {
  // A host that holds our stdin pipe open sets this so we exit with it: the
  // kernel closes the pipe when the host dies, even on a crash or force quit.
  const bye = () => void leave("stdin closed (STRUT_EXIT_ON_STDIN_EOF=1)");
  process.stdin.on("end", bye);
  process.stdin.on("error", bye);
  process.stdin.resume();
}

await mkdir(env["STRUT_WORKSPACE"], { recursive: true });

// startServer empties process.env (src/env.ts: the key must not be readable
// by a step), so read what the URL needs first.
const { STRUT_HOST: uiHost, STRUT_API_KEY: uiKey } = env;
const { startServer } = await import("./build/server.js");
const port = await startServer();
const url = `http://${uiHost}:${port}/?key=${uiKey}`;
console.error(`strut ui: ${url}`);
if (args.includes("--open")) {
  const [cmd, cmdArgs] =
    os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
