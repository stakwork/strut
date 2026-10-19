import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintStepSource, formatStepLint } from "./step-lint.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

  it("leaves other modules alone", () => {
    assert.deepEqual(lintStepSource('import { z } from "zod";\nimport { join } from "node:path";\nimport { createHash } from "node:crypto";'), []);
  });
});

describe("the module loader warns on a risky import from a workspace step (strut-resolve-hook.ts)", () => {
  it("names the file and the module on stderr, once, and still loads the step", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "strut-hook-"));
    const custom = path.join(dir, "steps", "custom");
    mkdirSync(path.join(custom, "risky"), { recursive: true });
    mkdirSync(path.join(custom, "clean"), { recursive: true });
    const def = (type: string, extra: string) =>
      `${extra}\nexport default { type: "${type}", input: { parse: (x) => x }, output: { parse: (x) => x }, async run() { return {}; } };\n`;
    writeFileSync(path.join(custom, "risky", "spawn.ts"), def("risky/spawn", 'import { spawn } from "node:child_process";\nimport { readFileSync } from "node:fs";\nvoid spawn; void readFileSync;'));
    writeFileSync(path.join(custom, "clean", "pure.ts"), def("clean/pure", 'import { join } from "node:path";\nvoid join;'));
    const entry = path.join(dir, "entry.mts"); // .mts: the temp dir has no package.json to make .ts ESM
    writeFileSync(
      entry,
      `import { buildRegistry } from ${JSON.stringify(path.join(ROOT, "src", "steps", "registry.ts"))};
const { registry } = await buildRegistry(${JSON.stringify(custom)});
console.log(JSON.stringify(Object.keys(registry).filter((k) => k.startsWith("risky/") || k.startsWith("clean/")).sort()));
// The hooks thread writes its console asynchronously: let it drain before exit.
await new Promise((r) => setTimeout(r, 300));
`,
    );
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", entry], {
        cwd: ROOT,
        env: { PATH: process.env["PATH"], HOME: process.env["HOME"], TMPDIR: process.env["TMPDIR"] },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim().split("\n").pop()!), ["clean/pure", "risky/spawn"], "warn-only: both steps load");
    const warnings = out.stderr.split("\n").filter((l) => l.startsWith("[steps] "));
    assert.equal(warnings.length, 2, out.stderr);
    assert.match(warnings[0]!, /risky\/spawn\.ts imports node:child_process: a custom step reaches the shell/);
    assert.match(warnings[1]!, /risky\/spawn\.ts imports node:fs:/);
    assert.ok(!out.stderr.includes("clean/pure"), "node:path is fine");
  });
});
