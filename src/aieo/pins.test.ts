// The npm package `aieo` (aieo/package.json) is built from this folder for
// Hive and staklink. Its provider SDKs must be the versions strut itself runs
// and tests (package.json), so a pin that moves in one manifest and not the
// other fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const strut = read("../../package.json");
const aieo = read("../../aieo/package.json");

test("aieo's npm package pins the provider SDKs strut runs, exactly", () => {
  const ours: Record<string, string> = { ...strut.devDependencies, ...strut.dependencies };
  for (const [name, pin] of Object.entries(aieo.dependencies as Record<string, string>)) {
    assert.match(pin, /^\d+\.\d+\.\d+$/, `${name}: aieo/package.json pins "${pin}", not an exact version`);
    assert.equal(ours[name], pin, `${name}: aieo/package.json pins ${pin}, strut's package.json ${ours[name] ?? "nothing"}`);
  }
});
