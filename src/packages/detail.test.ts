/**
 * A package's DETAIL (./detail.ts): what the store's package page shows,
 * read off a package directory alone — the apps' faces, each workflow's
 * inputs and what it reaches, the steps' secrets and lint, the Concept
 * pages, the README — with nothing loaded or run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readPackage } from "./format.js";
import { derivePackageDetail, stepFactsFromSource, summarizeDetail } from "./detail.js";

const FILES: Record<string, string> = {
  "strut.yaml": "package: acme/linear\nversion: 1.4.0\ndescription: Linear issues\nrequires:\n  secrets: [LINEAR_API_KEY]\n",
  "README.md": "# acme/linear\n\nIssues from Linear, as workflows.\n",
  "workflows/sync.yaml": `name: acme/linear/sync
description: Pull the open issues
input:
  team: { type: string, description: The team key }
  since: { type: string, required: false }
steps:
  - { id: fetch, type: list-issues }
  - { id: save, type: github/create-pr, config: { token: x } }
`,
  "workflows/triage.yaml": `name: acme/linear/triage
params:
  tools: [list-issues, update-issue]
steps:
  - id: plan
    type: agent
    config: { prompt: triage, agentTools: "{{ params.tools }}", secretsEnv: [SLACK_BOT_TOKEN] }
  - id: again
    type: subflow
    config: { workflow: sync }
  - id: elsewhere
    type: subflow
    config: { workflow: other/pkg/thing }
`,
  "workflows/report.yaml": `name: acme/linear/report
claims:
  - { text: it reports, checks: [{ step: http/verify }] }
steps:
  - { id: say, type: log, config: { message: weekly } }
  - { id: run, type: exec, config: { cmd: ls } }
`,
  "workflows/broken.yaml": "name: acme/linear/broken\nnot: a workflow\n",
  "steps/list-issues.ts": `import { z, defineStep } from "strut";
export default defineStep({
  type: "acme/linear/list-issues",
  description: "The open issues of a team",
  effect: "read",
  secrets: ["LINEAR_API_KEY"],
  input: z.object({ team: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    const key = await ctx.services.secrets.get("LINEAR_API_KEY");
    return ctx.services.http("https://api.linear.app", { headers: { authorization: key } });
  },
});
`,
  "steps/update-issue.ts": `import { z, defineStep } from "strut";
import { readFileSync } from "node:fs";
export default defineStep({
  type: "acme/linear/update-issue",
  description: 'Edit an issue',
  effect: "write",
  input: z.object({}),
  output: z.any(),
  async run() { return fetch(process.env.LINEAR_URL!); },
});
`,
  "steps/update-issue.claims.yaml": "- { text: it updates, checks: [{ step: http/verify }] }\n- { text: it is polite, checks: [{ step: http/verify }] }\n",
  "steps/_client.ts": "export const client = () => 1;\n",
  "concepts/Linear.md": "---\ndescription: The Linear tracker\n---\n\n# Linear\n\nWhere issues live.\n",
  "concepts/Issues.md": "---\ndescription: One unit of work\nparent: Linear\n---\n\nAn issue has a team.\n",
  "apps/issues/app.yaml": "title: Linear Issues\ndescription: The board\nicon: list-checks\ngrants:\n  workflows: [sync, triage]\n  steps: [update-issue]\n",
  "apps/issues/src/App.tsx": "export default () => null;\n",
  "apps/bare/app.yaml": "title: Bare\n",
  "apps/bare/src/App.tsx": "export default () => null;\n",
};

describe("a package's detail", () => {
  it("reads the apps, workflows, steps, Concepts and README off the directory, and what each reaches", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-detail-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), body);
      }
      const info = { ...(await readPackage(root)), dir: root };
      const d = await derivePackageDetail(info, {
        stepInfo: (type) => (type === "github/create-pr" ? { effect: "write", secrets: ["GITHUB_TOKEN"] } : type === "log" ? { effect: "read" } : undefined),
      });

      assert.equal(d.version, "1.4.0");
      assert.equal(d.digest, info.digest);
      assert.match(d.readme!, /^# acme\/linear/);
      assert.equal(d.files, Object.keys(FILES).length);
      assert.ok(d.bytes > 1000);

      // Apps: the manifest's face, the flags of what they may launch.
      assert.deepEqual(d.apps.map((a) => a.name), ["bare", "issues"]);
      const issues = d.apps[1]!;
      assert.equal(issues.title, "Linear Issues");
      assert.equal(issues.icon, "list-checks");
      assert.deepEqual(issues.grants, { workflows: ["sync", "triage"], steps: ["update-issue"] });
      assert.deepEqual(issues.can, { spends: true, acts: true, code: true }, "triage spends (an agent) and runs the package's steps; update-issue acts");
      assert.deepEqual(d.apps[0]!.can, { spends: false, acts: false, code: false });
      assert.equal(issues.files, 2);

      // Workflows: inputs, the closure's types, grants, flags, secrets.
      const by = Object.fromEntries(d.workflows.map((w) => [w.name, w]));
      assert.deepEqual(Object.keys(by).sort(), ["broken", "report", "sync", "triage"]);
      const sync = by["sync"]!;
      assert.equal(sync.description, "Pull the open issues");
      assert.deepEqual(sync.inputs, [
        { name: "team", type: "string", required: true, description: "The team key" },
        { name: "since", type: "string", required: false },
      ]);
      assert.deepEqual(sync.steps, ["list-issues", "github/create-pr"]);
      assert.deepEqual(sync.can, { spends: false, acts: true, code: true }, "the package's own step is code here; create-pr acts");
      assert.deepEqual(sync.secrets, ["GITHUB_TOKEN", "LINEAR_API_KEY"], "the lib step's one secret, and the package step's");
      const triage = by["triage"]!;
      assert.deepEqual(triage.grants, ["list-issues", "update-issue"], "agentTools read off params.tools");
      assert.deepEqual(triage.steps, ["agent", "subflow:sync", "list-issues", "github/create-pr", "subflow:other/pkg/thing"], "the package subflow is folded in, the outside one listed");
      assert.deepEqual(triage.can, { spends: true, acts: true, code: true });
      assert.ok(triage.secrets.includes("SLACK_BOT_TOKEN") && triage.secrets.includes("GITHUB_TOKEN"), JSON.stringify(triage.secrets));
      const report = by["report"]!;
      assert.deepEqual(report.can, { spends: false, acts: false, code: true }, "exec is code, log reads");
      assert.equal(report.claims, 1);
      assert.match(by["broken"]!.error!, /no steps/);

      // Steps: facts off the source, the lint's findings.
      assert.deepEqual(d.steps.map((s) => [s.name, s.helper ?? false, s.effect, s.secrets, s.lint.length, s.claims]), [
        ["_client", true, undefined, [], 0, undefined],
        ["list-issues", false, "read", ["LINEAR_API_KEY"], 0, undefined],
        ["update-issue", false, "write", [], 3, 2],
      ]);
      assert.equal(d.steps[1]!.description, "The open issues of a team");
      assert.match(d.steps[2]!.lint.join("\n"), /imports fs/);
      assert.match(d.steps[2]!.lint.join("\n"), /process\.env/);
      assert.match(d.steps[2]!.lint.join("\n"), /global fetch/);

      // Concepts and the whole.
      assert.deepEqual(d.concepts.map((c) => [c.name, c.parent, c.description]), [["Issues", "Linear", "One unit of work"], ["Linear", undefined, "The Linear tracker"]]);
      assert.match(d.concepts[1]!.docs!, /Where issues live/);
      assert.deepEqual(d.secrets, ["GITHUB_TOKEN", "LINEAR_API_KEY", "SLACK_BOT_TOKEN"]);
      assert.deepEqual(d.can, { spends: true, acts: true, code: true });

      const s = summarizeDetail(d);
      assert.deepEqual(s.apps.map((a) => a.title), ["Bare", "Linear Issues"]);
      assert.deepEqual([s.workflows, s.steps, s.concepts, s.readme], [4, 2, 2, true]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a step's facts off its source without loading it", () => {
    assert.deepEqual(stepFactsFromSource(FILES["steps/list-issues.ts"]!), { description: "The open issues of a team", effect: "read", secrets: ["LINEAR_API_KEY"] });
    assert.deepEqual(stepFactsFromSource("export default defineStep({ type: 'x', input: z.object({}), output: z.any(), async run(c, ctx) { return ctx?.services?.secrets?.get(`B_KEY`) ?? ctx.services.secrets.get(\"A_KEY\"); } });"), { secrets: ["A_KEY", "B_KEY"] });
    assert.deepEqual(stepFactsFromSource("nothing here"), {});
  });
});
