// Run by `npm run build` here (and so by strut's `npm run build:aieo`)
// before tsup. The package inlines the SDKs tsup.config.js lists in
// `noExternal` from the install the build runs in, so an install that is not
// the one package.json pins would ship SDK code strut's tests never ran.
// 0.2.8 did: built from a checkout whose node_modules predated the pin, it
// inlined @ai-sdk/anthropic 4.0.60 while declaring 4.0.71 (2026-11-05).
//
// Each package is found the way tsup's bundler finds it: from
// ../src/aieo up through every node_modules above it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import config from "./tsup.config.js";

const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies ?? {};

function installed(name) {
  for (let dir = join(here, "..", "src", "aieo"); ; dir = dirname(dir)) {
    const file = join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).version;
    if (dirname(dir) === dir) return undefined;
  }
}

const wrong = config.noExternal
  .filter((name) => name in pins)
  .map((name) => ({ name, pin: pins[name], have: installed(name) }))
  .filter(({ pin, have }) => have !== pin);

if (wrong.length) {
  console.error("aieo: the install does not match the pins this package inlines:");
  for (const { name, pin, have } of wrong) console.error(`  ${name}: pinned ${pin}, installed ${have ?? "nothing"}`);
  console.error("Run `yarn install --frozen-lockfile` at strut's root, then build again.");
  process.exit(1);
}
