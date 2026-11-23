import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `src/server.ts` boots the default server only when it IS the process
 * entry. The old check (`argv[1].endsWith("server.js")`) started it inside
 * any host whose own entry was called `server.js` and imported the barrel.
 * Under pm2, `argv[1]` is pm2's wrapper and the script it runs is the env's
 * `pm_exec_path` (pm2's lib/ProcessContainerFork.js imports it).
 *
 * Every case spawns a real child (`node --import tsx <entry>`, the
 * Dockerfile's CMD shape) on the fs backend with a throwaway workspace and
 * STRUT_PORT=0, and settles on the first of: the `ready` line `listen()`
 * prints on stdout, the child exiting, or a timeout.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BARREL = path.join(ROOT, "src", "index.ts");
const SERVER = path.join(ROOT, "src", "server.ts");

type Outcome = { ready: boolean; exited: boolean; code: number | null; stdout: string; stderr: string };

function boot(entry: string, workspace: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...extraEnv,
      PATH: process.env["PATH"],
      HOME: process.env["HOME"],
      TMPDIR: process.env["TMPDIR"],
      STRUT_PORT: "0",
      STRUT_HOST: "127.0.0.1",
      STRUT_WORKSPACE_BACKEND: "fs",
      STRUT_WORKSPACE: workspace,
      STRUT_SCHEDULER: "0",
      STRUT_AUTO_RESUME: "0",
    };
    const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let settled = false;
    const finish = (o: Omit<Outcome, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...o, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ready, exited: false, code: null });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (!ready && stdout.includes('"event":"ready"')) {
        ready = true;
        child.kill("SIGTERM");
        finish({ ready: true, exited: false, code: null });
      }
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("exit", (code) => finish({ ready, exited: true, code }));
  });
}

describe("server.ts as the process entry", { concurrency: true }, () => {
  let scratch: string;
  before(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "strut-server-main-"));
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("a host entry named server.js that imports the barrel does not boot the default server", async () => {
    const hostDir = path.join(scratch, "host");
    const entry = path.join(hostDir, "server.js");
    mkdirSync(hostDir);
    writeFileSync(
      entry,
      `import ${JSON.stringify(pathToFileURL(BARREL).href)};\n` +
        `console.log("host: imported strut from " + process.argv[1]);\n`,
    );
    const res = await boot(entry, path.join(scratch, "host-ws"), 60_000);
    assert.match(res.stdout, /host: imported strut from .*server\.js/, res.stderr);
    assert.equal(res.ready, false, `default server booted inside the host:\n${res.stdout}`);
    assert.equal(res.exited, true, `host process kept alive:\n${res.stdout}\n${res.stderr}`);
    assert.equal(res.code, 0, res.stderr);
  });

  it("run directly, it boots and prints the ready line", async () => {
    const res = await boot(SERVER, path.join(scratch, "direct-ws"), 60_000);
    assert.equal(res.ready, true, `${res.stdout}\n${res.stderr}`);
  });

  it("run through a symlink, it still boots", async () => {
    const link = path.join(scratch, "linked-server.ts");
    symlinkSync(SERVER, link);
    const res = await boot(link, path.join(scratch, "link-ws"), 60_000);
    assert.equal(res.ready, true, `${res.stdout}\n${res.stderr}`);
  });

  /** pm2's wrapper, as lib/ProcessContainerFork.js does it. */
  const pm2Wrapper = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const wrapper = path.join(dir, "ProcessContainerFork.js");
    writeFileSync(wrapper, `import(require("node:url").pathToFileURL(process.env.pm_exec_path).href);\n`);
    writeFileSync(path.join(dir, "package.json"), `{ "type": "commonjs" }\n`);
    return wrapper;
  };

  it("run by pm2 (argv[1] is pm2's wrapper, pm_exec_path is this file), it boots", async () => {
    const wrapper = pm2Wrapper(path.join(scratch, "pm2-direct"));
    const res = await boot(wrapper, path.join(scratch, "pm2-ws"), 60_000, { pm_exec_path: SERVER });
    assert.equal(res.ready, true, `${res.stdout}\n${res.stderr}`);
  });

  it("a host run by pm2 that imports the barrel does not boot the default server", async () => {
    const hostDir = path.join(scratch, "pm2-host");
    const entry = path.join(hostDir, "server.js");
    const wrapper = pm2Wrapper(path.join(scratch, "pm2-host-wrapper"));
    mkdirSync(hostDir);
    writeFileSync(path.join(hostDir, "package.json"), `{ "type": "module" }\n`);
    writeFileSync(
      entry,
      `import ${JSON.stringify(pathToFileURL(BARREL).href)};\n` +
        `console.log("host: imported strut under pm2 from " + process.env.pm_exec_path);\n`,
    );
    const res = await boot(wrapper, path.join(scratch, "pm2-host-ws"), 60_000, { pm_exec_path: entry });
    assert.match(res.stdout, /host: imported strut under pm2 from .*server\.js/, res.stderr);
    assert.equal(res.ready, false, `default server booted inside the host:\n${res.stdout}`);
    assert.equal(res.exited, true, `host process kept alive:\n${res.stdout}\n${res.stderr}`);
    assert.equal(res.code, 0, res.stderr);
  });
});
