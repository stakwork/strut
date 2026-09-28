/**
 * `npm run test:graph`, one run at a time per test database.
 *
 * Every live graph test wipes the database, so two runs against one Neo4j
 * fail each other in ways that look like flaky tests (IndexDropFailed, lock
 * timeouts, missing nodes). The second run is easy to start by accident:
 * another worktree, or a run whose `npm` was SIGKILLed, which orphans the
 * tsx test tree instead of stopping it. So a run holds a lock file with its
 * pid, a later run waits for it, and a dead holder's lock is taken over.
 */
import { spawn } from "node:child_process";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uri = process.env.STRUT_TEST_NEO4J_URI ?? "";
const lock = join(tmpdir(), `strut-test-graph-${uri.replace(/\W+/g, "_")}.lock`);

const holder = () => {
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return e.code === "EPERM" ? -1 : 0; // alive (someone else's) : gone
  }
};

// Written aside and linked into place: the lock never exists without its pid.
const mine = `${lock}.${process.pid}`;
writeFileSync(mine, String(process.pid));
for (let told = false; ; ) {
  try {
    linkSync(mine, lock);
    break;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const pid = holder();
  if (!pid) rmSync(lock, { force: true });
  else {
    if (!told) console.error(`[test:graph] waiting for the run holding ${lock} (pid ${pid}) to finish`);
    told = true;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
rmSync(mine);

const release = () => {
  try {
    if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock);
  } catch {}
};
// `npm run test:graph -- src/graph/claims.test.ts` runs just that file, under the same lock.
const files = process.argv.length > 2 ? process.argv.slice(2) : ["src/graph/*.test.ts", "src/steps/lib/graph/*.test.ts"];
const child = spawn("tsx", ["--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("exit", (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
