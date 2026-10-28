import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintStepSource, formatStepLint } from "./step-lint.js";
import { buildRegistry } from "./steps/registry.js";

describe("lintStepSource", () => {
  it("passes a step that stays on ctx.services", () => {
    const src = `import { z, defineStep } from "strut";
export default defineStep({
  type: "acme/ping", input: z.object({ url: z.string() }), output: z.object({ status: z.number() }),
  async run(cfg, ctx) {
    const token = await ctx.services.secrets.get("ACME_TOKEN");
    const res = await ctx.services.http(cfg.url, { headers: { authorization: \`Bearer \${token}\` } });
    const out = await ctx.services.shell({ cmd: "echo", args: ["hi"] });
    await ctx.services.artifacts.write(ctx.runId, "out.txt", out.stdout);
    return { status: res.status };
  },
});`;
    assert.deepEqual(lintStepSource(src), []);
  });

  it("finds the three ways past the boundary, by line, with what to use instead", () => {
    const src = [
      'import { spawn } from "node:child_process";',
      'import { readFile } from "fs/promises";',
      "const https = await import('node:https');",
      'const net = require("net");',
      "export default { async run() {",
      '  const key = process.env["ANTHROPIC_API_KEY"];',
      '  const r = await fetch("https://api.example.com", { headers: { authorization: key } });',
      "  return r.status;",
      "} };",
    ].join("\n");
    assert.deepEqual(
      lintStepSource(src).map((f) => `${f.line}:${f.message.split(" — ")[0]}`),
      ["1:imports child_process", "2:imports fs/promises", "3:imports https", "4:imports net", "6:reads process.env", "7:calls the global fetch"],
    );
    assert.match(formatStepLint(lintStepSource(src)), /^line 1: imports child_process — use ctx\.services\.shell/);
  });

  it("ignores comments and the services' own calls", () => {
    const src = `// a step must not read process.env or call fetch()
/* nor import "node:child_process"
   across lines */
export default { async run(cfg, ctx) {
  const r = await ctx.services.http("https://x"); // not the global fetch(
  return myClient.fetch(r); // a method named fetch is fine
} };`;
    assert.deepEqual(lintStepSource(src), []);
  });

  it("finds a step that opens or closes the deployment's graph itself", () => {
    const src = `import { z, defineStep, openGraphBackend } from "strut";
export default defineStep({ async run(cfg, ctx) {
  const b = await openGraphBackend(cfg);
  const rows = await ctx.services.graph.query("MATCH (n) RETURN n LIMIT 1");
  return rows;
} });`;
    assert.deepEqual(
      lintStepSource(src).map((f) => `${f.line}:${f.message.split(" — ")[0]}`),
      ["1:uses openGraphBackend", "3:uses openGraphBackend"],
    );
    assert.match(lintStepSource(src)[0]!.message, /ctx\.services\.graph.*graph\/query/);
  });

  it("leaves other modules alone", () => {
    assert.deepEqual(lintStepSource('import { z } from "zod";\nimport { join } from "node:path";\nimport { createHash } from "node:crypto";'), []);
  });
});

describe("the registry warns when it loads a workspace step that reaches past ctx.services (registry.ts)", () => {
  it("names the step, the file and each finding once per file version, and still loads it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "strut-load-lint-"));
    const custom = path.join(dir, "steps", "custom");
    mkdirSync(path.join(custom, "risky"), { recursive: true });
    mkdirSync(path.join(custom, "clean"), { recursive: true });
    const def = (type: string, extra: string) =>
      `${extra}\nexport default { type: "${type}", input: { parse: (x: unknown) => x }, output: { parse: (x: unknown) => x }, async run() { return {}; } };\n`;
    const risky = path.join(custom, "risky", "spawn.ts");
    writeFileSync(risky, def("risky/spawn", 'import { spawn } from "node:child_process";\nimport { readFileSync } from "node:fs";\nvoid spawn; void readFileSync;'));
    writeFileSync(path.join(custom, "clean", "pure.ts"), def("clean/pure", 'import { join } from "node:path";\nvoid join;'));

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      const first = await buildRegistry(custom);
      assert.ok(first.registry["risky/spawn"] && first.registry["clean/pure"], "warn-only: both steps load");
      assert.equal(first.sources["risky/spawn"], "custom");
      // The same file again: nothing new. Changed: warned again.
      await buildRegistry(custom);
      writeFileSync(risky, def("risky/spawn", 'import { spawn } from "node:child_process";\nvoid spawn;'));
      utimesSync(risky, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
      await buildRegistry(custom);
    } finally {
      console.warn = orig;
    }
    const ours = warnings.filter((w) => w.startsWith("[steps] "));
    assert.equal(ours.length, 2, warnings.join("\n"));
    assert.match(ours[0]!, /^\[steps\] risky\/spawn \(.*spawn\.ts\) reaches past ctx\.services/);
    assert.match(ours[0]!, /line 1: imports child_process — use ctx\.services\.shell/);
    assert.match(ours[0]!, /line 2: imports fs — use ctx\.services\.artifacts/);
    assert.match(ours[1]!, /line 1: imports child_process/);
    assert.ok(!ours[1]!.includes("imports fs"), "the new version has one finding");
    assert.ok(!warnings.some((w) => w.includes("clean/pure")), "node:path is fine");
  });
});
