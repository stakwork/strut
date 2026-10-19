import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bootEnv, KEEP_ENV, scrubProcessEnv } from "./env.js";
import { minimalEnv } from "./shell.js";

const SRC = dirname(fileURLToPath(import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every source file under src/ that is not a test or a test helper. */
const sources = () => walk(SRC).filter((p) => !/\.test\.ts$/.test(p) && !/test-util/.test(p));

describe("the env boundary (src/env.ts)", () => {
  // The test runner gives every file its own process, so scrubbing here
  // touches nothing else. Order matters within this file: the read-only
  // cases first, the scrub last.
  it("strut's own code reads the env through bootEnv(), never process.env", () => {
    const read = /process\.env\s*(\[|\.[A-Za-z_])/;
    const offenders = sources()
      .filter((p) => relative(SRC, p) !== "env.ts")
      .flatMap((p) =>
        readFileSync(p, "utf8")
          .split("\n")
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => read.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line))
          .map(({ i }) => `${relative(SRC, p)}:${i + 1}`),
      );
    assert.deepEqual(offenders, [], "a process.env read outside env.ts: use bootEnv() (see src/env.ts)");
  });

  it("only shell.ts and the STT model unpack spawn a child directly", () => {
    const allowed = new Set(["shell.ts", "audio/stt.ts"]);
    const offenders = sources()
      .filter((p) => /\b(?:from|import|require)\s*\(?\s*["'](?:node:)?child_process["']/.test(readFileSync(p, "utf8")))
      .map((p) => relative(SRC, p))
      .filter((p) => !allowed.has(p));
    assert.deepEqual(offenders, [], "a child_process import outside shell.ts: spawn through runProcess / ctx.services.shell, whose env is scrubbed");
  });

  it("before the scrub, bootEnv() IS process.env", () => {
    assert.equal(bootEnv(), process.env);
    process.env["STRUT_ENV_TEST_LIVE"] = "1";
    assert.equal(bootEnv()["STRUT_ENV_TEST_LIVE"], "1");
    delete process.env["STRUT_ENV_TEST_LIVE"];
  });

  it("the scrub keeps the shell's allowlist, drops the rest from process.env, and keeps every value in the boot snapshot", () => {
    process.env["STRUT_SECRET_KEY"] = "sk-deployment";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";
    process.env["STRUT_PORT"] = "3999";
    process.env["KEPT_BY_REQUEST"] = "yes";
    process.env["STRUT_ENV_KEEP"] = "KEPT_BY_REQUEST, ALSO_KEPT";
    process.env["ALSO_KEPT"] = "yes";
    const path = process.env["PATH"];

    const gone = scrubProcessEnv();

    for (const k of ["STRUT_SECRET_KEY", "ANTHROPIC_API_KEY", "STRUT_PORT", "STRUT_ENV_KEEP"]) {
      assert.equal(process.env[k], undefined, `${k} should be gone from process.env`);
      assert.ok(gone.includes(k), `${k} should be reported`);
    }
    assert.equal(process.env["PATH"], path, "PATH stays");
    assert.equal(process.env["KEPT_BY_REQUEST"], "yes", "STRUT_ENV_KEEP keeps a named variable");
    assert.equal(process.env["ALSO_KEPT"], "yes");
    assert.deepEqual(gone, [...gone].sort());
    for (const k of KEEP_ENV) assert.ok(!gone.includes(k), `${k} is on the keep list`);

    const boot = bootEnv();
    assert.notEqual(boot, process.env, "the snapshot is a copy now");
    assert.equal(boot["STRUT_SECRET_KEY"], "sk-deployment");
    assert.equal(boot["ANTHROPIC_API_KEY"], "sk-ant");
    assert.equal(boot["STRUT_PORT"], "3999");
    assert.equal(boot["PATH"], path);

    // The child env is built from the snapshot: the same allowlist, nothing more.
    const child = minimalEnv();
    assert.equal(child["PATH"], path);
    assert.equal(child["STRUT_SECRET_KEY"], undefined);
    assert.equal(child["KEPT_BY_REQUEST"], undefined, "STRUT_ENV_KEEP widens the server's env, never a child's");

    // Idempotent: the second call changes nothing and answers the same list.
    process.env["LATE"] = "1";
    assert.deepEqual(scrubProcessEnv(), gone);
    assert.equal(process.env["LATE"], "1");
    delete process.env["LATE"];
  });
});
