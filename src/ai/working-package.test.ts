import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nameInPackage, packageLine, packageOfLine, stampStepType, stampWorkflowName } from "./working-package.js";

describe("the working package (plans/packages-ux.md §3)", () => {
  it("writes the [package] line and reads the segment back", () => {
    const line = packageLine("tools");
    assert.ok(line.startsWith("[package] tools — "));
    assert.equal(packageOfLine(line), "tools");
    assert.equal(packageOfLine("[package] tools"), "tools");
    assert.equal(packageOfLine("make me a workflow"), null);
    assert.equal(packageOfLine("[attachment] x (text/plain, 1 B) — saved at /x"), null);
  });

  it("composes a stored name under the prefix, never twice", () => {
    assert.equal(nameInPackage("acme/tools", "summarize"), "acme/tools/summarize");
    assert.equal(nameInPackage("acme/tools", "media/clip"), "acme/tools/media/clip");
    assert.equal(nameInPackage("acme/tools", "acme/tools/summarize"), "acme/tools/summarize");
    assert.equal(nameInPackage(undefined, "summarize"), "summarize");
  });

  it("stamps the stored name into the YAML, and leaves one that says it alone", () => {
    const out = stampWorkflowName("name: summarize\nsteps:\n  - { id: a, type: log, config: { message: hi } }\n", "acme/tools/summarize");
    assert.match(out, /^name: acme\/tools\/summarize\n/);
    assert.match(out, /type: log/);
    const same = "name: acme/tools/summarize\nsteps: []\n";
    assert.equal(stampWorkflowName(same, "acme/tools/summarize"), same);
    assert.equal(stampWorkflowName("- not\n- a mapping\n", "x"), "- not\n- a mapping\n");
  });

  it("moves the defineStep type literal to the stored name", () => {
    const code = `import { z, defineStep } from "strut";\nexport default defineStep({ type: "shout", input: z.object({}), output: z.any(), async run() { return "shout"; } });\n`;
    const out = stampStepType(code, "shout", "acme/tools/shout");
    assert.match(out, /type: "acme\/tools\/shout"/);
    assert.match(out, /return "shout"/, "only the type literal moves");
    assert.equal(stampStepType(code, "acme/tools/shout", "acme/tools/shout"), code);
    assert.equal(stampStepType(`type: 'x/y'`, "x/y", "p/x/y"), `type: 'p/x/y'`);
  });
});
