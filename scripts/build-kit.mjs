#!/usr/bin/env node
/**
 * Build the app kit's VENDOR LAYER (plans/apps.md §3) into kit/vendor/ — the
 * frozen browser bundles + import-map.json every app build resolves against
 * (src/apps/kit.ts). Part of `npm run build`, so `prepare` runs it too: a
 * checkout, a git-dependency install (the mcp host) and the desktop package
 * all end up with the layer. The Docker image builds it in a stage of its own
 * (Dockerfile `kit`).
 *
 * The kit's dependencies (React and the rest of the set) install into
 * kit/node_modules from kit/yarn.lock — never strut's own node_modules — with
 * yarn v1, the lockfile's tool: `yarn` on PATH, else `npx yarn@1.22.22`.
 * `--production=false` because the set is the kit's devDependencies, which a
 * NODE_ENV=production install would skip.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "kit");
const log = (m) => console.log(`[build-kit] ${m}`);

if (!existsSync(join(KIT, "package.json"))) {
  console.error(`[build-kit] no kit at ${KIT}`);
  process.exit(1);
}

const hasYarn = spawnSync("yarn", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const [cmd, pre] = hasYarn ? ["yarn", []] : ["npx", ["--yes", "yarn@1.22.22"]];
const yarn = (args) => {
  const r = spawnSync(cmd, [...pre, ...args], { cwd: KIT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`[build-kit] ${[cmd, ...pre, ...args].join(" ")} failed (${r.status ?? r.error?.message})`);
    process.exit(1);
  }
};

const t0 = Date.now();
log(`installing kit/ from kit/yarn.lock (${hasYarn ? "yarn" : "npx yarn@1.22.22: no yarn on PATH"})`);
yarn(["install", "--frozen-lockfile", "--ignore-scripts", "--production=false", "--non-interactive", "--silent"]);
yarn(["build:vendor"]);
log(`kit/vendor built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
