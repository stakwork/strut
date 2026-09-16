import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { flow, step } from "../../core.js";
import { runWorkflow } from "../../runner.js";
import { coreRegistry } from "../registry.js";
import { MemoryRunStore } from "../../store.js";
import { RunController } from "../../run-control.js";
import { fileArtifactsCapability, secretsCapability, shellCapability } from "../../capabilities.js";
import { runProcess } from "../../shell.js";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-exec-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const artifacts = () => fileArtifactsCapability(join(root, "artifacts"));
const services = () => ({
  artifacts: artifacts(),
  shell: shellCapability(),
  secrets: secretsCapability({ MY_TOKEN: "sk-1234567890abcdef", SHORT: "abc" }),
});

async function runExec(config: Record<string, unknown>, opts: { controller?: RunController } = {}) {
  const wf = flow("exec-test", { input: z.object({}), steps: [step("x", "exec", config)] });
  return runWorkflow(wf, {}, coreRegistry(), { store: new MemoryRunStore(), services: services(), ...opts });
}
const errText = (r: { error?: unknown }) => JSON.stringify(r.error ?? "");
type Out = { code: number | null; stdout: string; stderr: string; json?: unknown; cwd: string; durationMs: number; truncated: boolean };
// Resolved before the suite registers so the uv case can declare itself skipped.
const UV_AVAILABLE = await hasUv();

describe("exec (core)", () => {
  it("runs a program with verbatim args and captures stdout + exit code", async () => {
    const r = await runExec({ cmd: "echo", args: ["hello", 42, true] });
    assert.equal(r.status, "success", errText(r));
    const out = r.output as Out;
    assert.equal(out.stdout, "hello 42 true\n");
    assert.equal(out.code, 0);
    assert.equal(out.truncated, false);
    assert.ok(out.durationMs >= 0);
  });

  it("defaults the working dir to the run's artifact dir", async () => {
    const r = await runExec({ cmd: "pwd" });
    assert.equal(r.status, "success", errText(r));
    const out = r.output as Out;
    const expected = join(root, "artifacts", r.runId);
    assert.equal(out.cwd, expected);
    assert.equal(out.stdout.trim(), await realpath(expected));
  });

  it("resolves a relative cwd inside the artifact dir and rejects escapes", async () => {
    const ok = await runExec({ cmd: "pwd", cwd: "sub/dir" });
    assert.equal(ok.status, "success", errText(ok));
    assert.equal((ok.output as Out).cwd, join(root, "artifacts", ok.runId, "sub/dir"));
    const bad = await runExec({ cmd: "pwd", cwd: "../elsewhere" });
    assert.equal(bad.status, "error");
    assert.match(errText(bad), /escapes the run's artifact dir/);
  });

  it("writes an inline script into the working dir and appends its path", async () => {
    const r = await runExec({ cmd: "sh", args: ["-e"], script: "echo from-script\npwd" });
    assert.equal(r.status, "success", errText(r));
    const out = r.output as Out;
    assert.match(out.stdout, /^from-script\n/);
    const files = await artifacts().list(r.runId);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^exec-.*\.sh$/, files[0]);

    const named = await runExec({ cmd: "sh", script: "echo named", scriptFile: "tools/hi.sh" });
    assert.equal(named.status, "success", errText(named));
    assert.deepEqual(await artifacts().list(named.runId), ["tools/hi.sh"]);

    const bad = await runExec({ cmd: "sh", script: "echo x", scriptFile: "../evil.sh" });
    assert.equal(bad.status, "error");
    assert.match(errText(bad), /scriptFile must be a relative path/);
  });

  it("pipes stdin (JSON for non-strings) and parses JSON stdout", async () => {
    const r = await runExec({ cmd: "cat", stdin: { a: 1, b: [2] }, parseJson: true });
    assert.equal(r.status, "success", errText(r));
    assert.deepEqual((r.output as Out).json, { a: 1, b: [2] });
    const s = await runExec({ cmd: "cat", stdin: "plain text" });
    assert.equal((s.output as Out).stdout, "plain text");
  });

  it("parseJson fails with an actionable error when stdout isn't JSON", async () => {
    const r = await runExec({ cmd: "echo", args: ["not json"], parseJson: true });
    assert.equal(r.status, "error");
    assert.match(errText(r), /parseJson.*not JSON.*not json/);
  });

  it("a non-zero exit fails the step with stderr in the message", async () => {
    const r = await runExec({ cmd: "sh", args: ["-c", "echo boom >&2; exit 3"] });
    assert.equal(r.status, "error");
    assert.match(errText(r), /exited with code 3/);
    assert.match(errText(r), /boom/);
  });

  it("allowFailure returns the exit code instead of throwing", async () => {
    const r = await runExec({ cmd: "sh", args: ["-c", "echo boom >&2; exit 3"], allowFailure: true, parseJson: true });
    assert.equal(r.status, "success", errText(r));
    const out = r.output as Out;
    assert.equal(out.code, 3);
    assert.equal(out.stderr, "boom\n");
    assert.equal("json" in out, false); // not parsed on failure
  });

  it("a program that isn't on PATH is a clear error", async () => {
    const r = await runExec({ cmd: "definitely-not-a-real-command-xyz" });
    assert.equal(r.status, "error");
    assert.match(errText(r), /command not found: definitely-not-a-real-command-xyz/);
  });

  it("times out", async () => {
    const t0 = Date.now();
    const r = await runExec({ cmd: "sleep", args: ["30"], timeoutMs: 300 });
    assert.equal(r.status, "error");
    assert.match(errText(r), /timed out after 300ms/);
    assert.ok(Date.now() - t0 < 5000);
  });

  it("cancel kills the child and the run finalizes as cancelled", async () => {
    const controller = new RunController("r-exec", "exec-test");
    const t0 = Date.now();
    const pending = runExec({ cmd: "sleep", args: ["30"] }, { controller });
    await new Promise((r) => setTimeout(r, 400));
    controller.cancel();
    const r = await pending;
    assert.equal(r.status, "cancelled", errText(r));
    assert.ok(Date.now() - t0 < 5000);
  });

  it("secretsEnv injects values into the child env and masks them out of the output", async () => {
    const r = await runExec({
      cmd: "sh",
      args: ["-c", 'echo "tok=$MY_TOKEN short=$SHORT"; echo "$MY_TOKEN" >&2'],
      secretsEnv: ["MY_TOKEN", "SHORT"],
    });
    assert.equal(r.status, "success", errText(r));
    const out = r.output as Out;
    assert.equal(out.stdout, "tok=[MASKED_SECRET] short=abc\n"); // <6 chars: not maskable
    assert.equal(out.stderr, "[MASKED_SECRET]\n");
    assert.doesNotMatch(JSON.stringify(out), /sk-1234567890abcdef/);

    const missing = await runExec({ cmd: "true", secretsEnv: ["NOPE"] });
    assert.equal(missing.status, "error");
    assert.match(errText(missing), /secret .*NOPE.* is not in the secret store/); // errText is JSON: quotes escaped
  });

  it("scrubs the env; `env` config widens it with plain values", async () => {
    process.env.STRUT_TEST_FAKE_KEY = "sk-super-secret";
    try {
      const r = await runExec({ cmd: "sh", args: ["-c", 'echo "k=$STRUT_TEST_FAKE_KEY e=$EXTRA p=${PATH:+set}"'], env: { EXTRA: 7 } });
      assert.equal(r.status, "success", errText(r));
      assert.equal((r.output as Out).stdout, "k= e=7 p=set\n");
    } finally {
      delete process.env.STRUT_TEST_FAKE_KEY;
    }
  });

  it("caps output keeping head and tail, and reports truncation", async () => {
    const r = await runExec({
      cmd: "sh",
      args: ["-c", "i=0; while [ $i -lt 3000 ]; do echo line$i; i=$((i+1)); done"],
      maxOutputChars: 1000,
    });
    assert.equal(r.status, "success", errText(r));
    const out = r.output as Out;
    assert.equal(out.truncated, true);
    assert.match(out.stdout, /^line0\n/);
    assert.match(out.stdout, /line2999\n$/);
    assert.match(out.stdout, /\[\.\.\. \d+ chars truncated \.\.\.\]/);
    assert.ok(out.stdout.length < 1100);
  });

  it("falls back to a local shell + explicit cwd when the services bag is bare", async () => {
    const wf = flow("exec-bare", { input: z.object({}), steps: [step("x", "exec", { cmd: "pwd", cwd: root })] });
    const r = await runWorkflow(wf, {}, coreRegistry(), { store: new MemoryRunStore(), services: {} });
    assert.equal(r.status, "success", errText(r));
    assert.equal((r.output as Out).stdout.trim(), await realpath(root));
    const noCwd = await runWorkflow(
      flow("exec-bare2", { input: z.object({}), steps: [step("x", "exec", { cmd: "pwd" })] }),
      {},
      coreRegistry(),
      { store: new MemoryRunStore(), services: {} },
    );
    assert.equal(noCwd.status, "error");
    assert.match(errText(noCwd), /no artifacts capability/);
  });

  // Live: only when `uv` is on PATH (no network needed — the script declares no deps).
  it("runs Python through uv with an inline (PEP 723) script", { skip: !UV_AVAILABLE }, async () => {
    const r = await runExec({
      cmd: "uv",
      args: ["run", "--quiet"],
      parseJson: true,
      script: [
        "# /// script",
        '# requires-python = ">=3.9"',
        "# dependencies = []",
        "# ///",
        "import json, sys",
        'print(json.dumps({"major": sys.version_info[0], "argv": len(sys.argv)}))',
      ].join("\n"),
    });
    assert.equal(r.status, "success", errText(r));
    const out = r.output as Out;
    assert.deepEqual(out.json, { major: 3, argv: 1 });
    assert.match((await artifacts().list(r.runId))[0]!, /\.py$/);
  });
});

async function hasUv(): Promise<boolean> {
  try {
    const r = await runProcess({ cmd: "uv", args: ["--version"], cwd: tmpdir(), timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}
