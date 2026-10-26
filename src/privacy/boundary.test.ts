// The module boundary: privacy is a folder core does not know. Three rules, each checked on the real
// tree and, so the checks cannot rot into passing, on synthetic violations.
//   1. src/privacy/ imports from outside itself in ONE file, host.ts (tests and testing/ excepted:
//      they drive core on purpose).
//   2. Outside src/privacy/ and src/steps/lib/privacy/, only createStrut.ts (register.js, seed.js) and
//      index.ts (index.js, seed.js) import from privacy/; the lib steps only privacy/index.js.
//   3. No other core file mentions privacy in code (comments are fine). moved.ts is exempt: it names
//      the data folder's `privacy/vault` among what a move leaves behind, a path, not the module.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVACY = join(SRC, "privacy");
const LIB_PRIVACY = join(SRC, "steps", "lib", "privacy");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** Relative module specifiers imported by a source text. */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)) out.push(m[1]!);
  return out.filter((s) => s.startsWith("."));
}

const inside = (dir: string, p: string) => p === dir || p.startsWith(dir + "/");
const isTest = (f: string) => /\.test\.ts$/.test(f) || f.includes("/privacy/testing/");

/** Rule 1 */
export function outwardImports(files: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [f, text] of Object.entries(files)) {
    if (!inside(PRIVACY, f) || f === join(PRIVACY, "host.ts") || isTest(f)) continue;
    for (const s of importsOf(text)) if (!inside(PRIVACY, resolve(dirname(f), s))) bad.push(`${relative(SRC, f)} imports ${s}`);
  }
  return bad;
}

/** Rule 2 */
export function inwardImports(files: Record<string, string>): string[] {
  const allowed: Record<string, string[]> = {
    [join(SRC, "createStrut.ts")]: ["privacy/register.js", "privacy/seed.js"],
    [join(SRC, "index.ts")]: ["privacy/index.js", "privacy/seed.js"],
  };
  const bad: string[] = [];
  for (const [f, text] of Object.entries(files)) {
    if (inside(PRIVACY, f) || isTest(f)) continue;
    for (const s of importsOf(text)) {
      const target = resolve(dirname(f), s);
      if (!inside(PRIVACY, target)) continue;
      const name = relative(SRC, target);
      const ok = inside(LIB_PRIVACY, f) ? name === "privacy/index.js" : (allowed[f] ?? []).includes(name);
      if (!ok) bad.push(`${relative(SRC, f)} imports ${s}`);
    }
  }
  return bad;
}

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1");

/** Rule 3 */
export function wordInCode(files: Record<string, string>): string[] {
  const free = (f: string) =>
    inside(PRIVACY, f) || inside(LIB_PRIVACY, f) || isTest(f) || inside(join(SRC, "graph", "fixtures"), f) ||
    f === join(SRC, "createStrut.ts") || f === join(SRC, "index.ts") || f === join(SRC, "moved.ts");
  return Object.entries(files).filter(([f, text]) => !free(f) && /privacy/.test(stripComments(text))).map(([f]) => relative(SRC, f));
}

const tree = Object.fromEntries([...walk(SRC), ...walk(join(SRC, "..", "web", "src"))].filter((f) => !f.includes("/web/")).map((f) => [f, readFileSync(f, "utf-8")]));

describe("privacy module boundary", () => {
  it("1: only host.ts reaches outside src/privacy/", () => assert.deepEqual(outwardImports(tree), []));
  it("2: core reaches into privacy/ only through createStrut.ts and index.ts; the lib steps only through privacy/index.js", () => assert.deepEqual(inwardImports(tree), []));
  it("3: no other core file mentions privacy in code", () => assert.deepEqual(wordInCode(tree), []));
  it("the generic seam file has no feature words at all", () => assert.ok(!/privacy|pseudonym|anonym/i.test(readFileSync(join(SRC, "extensions.ts"), "utf-8"))));

  it("the checks fail on violations", () => {
    assert.equal(outwardImports({ [join(PRIVACY, "x.ts")]: `import { a } from "../core.js";` }).length, 1);
    assert.equal(outwardImports({ [join(PRIVACY, "x.ts")]: `const m = await import("../env.js");` }).length, 1);
    assert.equal(outwardImports({ [join(PRIVACY, "refine", "x.ts")]: `import { a } from "../policy.js"; import z from "zod"; import "node:fs";` }).length, 0);
    assert.equal(outwardImports({ [join(PRIVACY, "host.ts")]: `export { a } from "../core.js";` }).length, 0);
    assert.equal(inwardImports({ [join(SRC, "llm.ts")]: `import { x } from "./privacy/index.js";` }).length, 1);
    assert.equal(inwardImports({ [join(SRC, "createStrut.ts")]: `import { x } from "./privacy/middleware.js";` }).length, 1);
    assert.equal(inwardImports({ [join(SRC, "steps/lib/privacy/a.ts")]: `import { x } from "../../../privacy/detect.js";` }).length, 1);
    assert.equal(inwardImports({ [join(SRC, "steps/lib/privacy/a.ts")]: `import { x } from "../../../privacy/index.js";` }).length, 0);
    assert.equal(wordInCode({ [join(SRC, "runner.ts")]: `const privacy = 1;` }).length, 1);
    assert.equal(wordInCode({ [join(SRC, "runner.ts")]: `// privacy is a comment\n/* privacy */ const a = 1;` }).length, 0);
  });
});
