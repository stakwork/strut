import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell, runCmd, minimalEnv, runProcess } from "./shell.js";
import { buildTools } from "./ai/tools.js";
import type { AiDeps } from "./ai/prompts.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "strut-shell-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── shell helpers ───────────────────────────────────────────────────────────

describe("shell helpers", () => {
  it("runShell executes in the given cwd", async () => {
    const out = await runShell("pwd", dir);
    // macOS tmpdir may resolve through /private — compare the tail.
    assert.ok(out.trim().endsWith(dir.replace(/^\/private/, "")) || out.trim() === dir);
  });

  it("scrubs the env: allowlisted vars pass, secrets don't", async () => {
    process.env.STRUT_TEST_FAKE_KEY = "sk-super-secret";
    try {
      const out = await runShell("env", dir);
      assert.doesNotMatch(out, /STRUT_TEST_FAKE_KEY|sk-super-secret/);
      assert.match(out, /(^|\n)PATH=/);
    } finally {
      delete process.env.STRUT_TEST_FAKE_KEY;
    }
  });

  it("extraEnv widens the scrubbed env without unscrubbing it", async () => {
    process.env.STRUT_TEST_FAKE_KEY = "sk-super-secret";
    try {
      const out = await runShell('echo "got:$INJECTED_TOKEN"; env', dir, 15000, 10000, {
        INJECTED_TOKEN: "tok-abc123",
      });
      assert.match(out, /got:tok-abc123/); // injected value expands in the shell
      assert.doesNotMatch(out, /STRUT_TEST_FAKE_KEY/); // scrubbing still applies
    } finally {
      delete process.env.STRUT_TEST_FAKE_KEY;
    }
  });

  it("empty extraEnv is identical to no extraEnv", async () => {
    const out = await runShell("echo ok", dir, 15000, 10000, {});
    assert.equal(out.trim(), "ok");
  });

  it("minimalEnv contains only allowlisted keys", () => {
    process.env.STRUT_TEST_FAKE_KEY = "x";
    try {
      const env = minimalEnv();
      assert.equal(env.STRUT_TEST_FAKE_KEY, undefined);
      assert.ok(env.PATH);
    } finally {
      delete process.env.STRUT_TEST_FAKE_KEY;
    }
  });

  it("caps oversized output", async () => {
    const out = await runShell("yes x | head -c 5000", dir, 10_000, 100);
    assert.ok(out.length < 200);
    assert.match(out, /truncated/);
  });

  it("times out a hung command", async () => {
    await assert.rejects(() => runShell("sleep 5", dir, 300), /timed out/);
  });

  it("rejects on failure with stderr", async () => {
    await assert.rejects(() => runShell("ls /definitely/not/a/path", dir), /Command failed/);
  });

  it("caps oversized stderr on failure", async () => {
    await assert.rejects(
      () => runShell("yes x | head -c 200000 1>&2; exit 2", dir, 10_000, 100),
      (e: Error) => e.message.length < 400 && /truncated/.test(e.message),
    );
  });

  it("runCmd passes args without shell interpolation", async () => {
    const out = await runCmd("echo", ["$HOME && rm -rf /"], dir);
    assert.equal(out.trim(), "$HOME && rm -rf /");
  });
});

// ── chat builder bash tool ──────────────────────────────────────────────────

/** buildTools only touches deps lazily inside execute(); a stub is enough. */
const stubDeps = (over: Partial<AiDeps> = {}): AiDeps =>
  ({ workspace: {}, registry: {}, store: {}, getRegistry: async () => ({}), ...over }) as AiDeps;

describe("chat bash tool", () => {
  it("is absent without deps.shell, present with it", () => {
    assert.equal("bash" in buildTools(stubDeps()), false);
    assert.equal("bash" in buildTools(stubDeps({ shell: { cwd: dir } })), true);
  });

  it("web tools are only what the host built (deps.webTools)", () => {
    const none = buildTools(stubDeps());
    assert.equal("web_search" in none, false);
    assert.equal("web_fetch" in none, false);
    const both = buildTools(stubDeps({ webTools: { web_search: { x: 1 }, web_fetch: { y: 2 } } }));
    assert.deepEqual(both["web_search"], { x: 1 });
    assert.deepEqual(both["web_fetch"], { y: 2 });
  });

  it("executes in the workspace dir and creates scratch/", async () => {
    const tools = buildTools(stubDeps({ shell: { cwd: dir } })) as Record<
      string,
      { execute: (a: { command: string; timeoutMs: number }) => Promise<{ output?: string; error?: string }> }
    >;
    const res = await tools.bash.execute({ command: "echo hello-from-bash", timeoutMs: 10_000 });
    assert.equal(res.output?.trim(), "hello-from-bash");
    assert.ok((await readdir(dir)).includes("scratch"));
  });

  it("returns errors as data, not throws", async () => {
    const tools = buildTools(stubDeps({ shell: { cwd: dir } })) as Record<
      string,
      { execute: (a: { command: string; timeoutMs: number }) => Promise<{ output?: string; error?: string }> }
    >;
    const res = await tools.bash.execute({ command: "exit 7", timeoutMs: 10_000 });
    assert.match(res.error ?? "", /Command failed \(7\)/);
  });

  it("does not leak server env to commands", async () => {
    process.env.STRUT_TEST_FAKE_KEY = "sk-super-secret";
    try {
      const tools = buildTools(stubDeps({ shell: { cwd: dir } })) as Record<
        string,
        { execute: (a: { command: string; timeoutMs: number }) => Promise<{ output?: string; error?: string }> }
      >;
      const res = await tools.bash.execute({ command: "env", timeoutMs: 10_000 });
      assert.doesNotMatch(res.output ?? "", /sk-super-secret/);
    } finally {
      delete process.env.STRUT_TEST_FAKE_KEY;
    }
  });
});

// ── runProcess (the shell capability's primitive) ───────────────────────────

describe("runProcess", () => {
  it("returns the exit code instead of throwing, with both streams", async () => {
    const r = await runProcess({ cmd: "sh", args: ["-c", "echo out; echo err >&2; exit 2"], cwd: dir });
    assert.equal(r.code, 2);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, "out\n");
    assert.equal(r.stderr, "err\n");
    assert.equal(r.timedOut, false);
    assert.equal(r.truncated, false);
  });

  it("pipes stdin and closes it", async () => {
    const r = await runProcess({ cmd: "cat", cwd: dir, stdin: "abc" });
    assert.equal(r.stdout, "abc");
    assert.equal(r.code, 0);
  });

  it("rejects with a clear error when the program isn't on PATH", async () => {
    await assert.rejects(
      runProcess({ cmd: "definitely-not-a-real-command-xyz", cwd: dir }),
      /command not found: definitely-not-a-real-command-xyz/,
    );
  });

  it("keeps the head and the tail past the output cap without killing the child", async () => {
    const r = await runProcess({ cmd: "sh", args: ["-c", "yes | head -n 2000; echo END"], cwd: dir, maxOutputChars: 100 });
    assert.equal(r.code, 0); // ran to completion
    assert.equal(r.truncated, true);
    assert.match(r.stdout, /^y\ny\n/);
    assert.match(r.stdout, /END\n$/);
    assert.match(r.stdout, /\[\.\.\. \d+ chars truncated \.\.\.\]/);
  });

  it("times out with SIGKILL", async () => {
    const r = await runProcess({ cmd: "sleep", args: ["30"], cwd: dir, timeoutMs: 200 });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
    assert.equal(r.signal, "SIGKILL");
  });

  it("abort kills the whole process group, not just the immediate child", async () => {
    const ac = new AbortController();
    // The shell prints its background child's pid, then waits on it.
    const pending = runProcess({ cmd: "sh", args: ["-c", "sleep 30 & echo $!; wait"], cwd: dir, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await pending;
    assert.equal(r.code, null);
    assert.equal(r.signal, "SIGTERM");
    const grandchild = Number(r.stdout.trim());
    assert.ok(grandchild > 0, r.stdout);
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/); // gone with the group
  });
});
