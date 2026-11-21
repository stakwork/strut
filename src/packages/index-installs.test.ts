/**
 * INSTALL COUNTS on an index (./index-installs.ts): a box counted once per
 * release it takes, every row kept, the total and the last 30 days read
 * from the rows; and the box's side (./install-pings.ts): its id made once,
 * and a ping only for what a followed index lists from that source.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallCounts, INSTALL_RECENT_DAYS, installPingProblem, type InstallPing } from "./index-installs.js";
import { boxIdOf, createInstallPings } from "./install-pings.js";
import { liveRunnableOf, liveSalesOf } from "./index.js";
import type { InstallResult, PackageInstallReport } from "./install.js";

const DIGEST = (n: number) => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;
const BOX = (n: number) => n.toString(16).padStart(2, "0").repeat(16);
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-21T15:00:00Z");

describe("install counts", () => {
  let root: string;
  let counts: InstallCounts;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-installs-"));
    counts = InstallCounts.open(join(root, "index", "installs.db"));
  });
  afterEach(async () => {
    counts.close();
    await rm(root, { recursive: true, force: true });
  });

  const ping = (box: number, digest: number, pkg = "acme/linear"): InstallPing => ({ package: pkg, box: BOX(box), digest: DIGEST(digest), source: `pk:${"y".repeat(52)}/${pkg}` });

  it("counts a box once per release, keeps every release it takes, and reads all time beside the last 30 days", () => {
    // 40 days ago: two boxes take the first release.
    assert.equal(counts.add(ping(1, 1), NOW - 40 * DAY), true);
    assert.equal(counts.add(ping(2, 1), NOW - 40 * DAY), true);
    // The same box saying it again is the same install.
    assert.equal(counts.add(ping(1, 1), NOW - 39 * DAY), false);
    // 3 days ago box 1 updates to the second release; today a third box installs it.
    assert.equal(counts.add(ping(1, 2), NOW - 3 * DAY), true);
    assert.equal(counts.add(ping(3, 2), NOW), true);
    counts.add(ping(9, 1, "acme/notion"), NOW);

    const s = counts.stats("acme/linear", NOW);
    assert.equal(s.total, 4, "every release a box took, all time");
    assert.equal(s.boxes, 3);
    assert.equal(s.recent.days, INSTALL_RECENT_DAYS);
    assert.equal(s.recent.installs, 2);
    assert.equal(s.recent.boxes, 2);
    assert.equal(s.recent.daily.length, 30);
    assert.deepEqual(s.recent.daily.slice(-4), [1, 0, 0, 1], "oldest first; the last is today");
    assert.equal(s.recent.daily.reduce((a, b) => a + b, 0), 2);

    // Nothing is dropped as the window moves: 60 days on, the total is the same.
    const later = counts.stats("acme/linear", NOW + 60 * DAY);
    assert.equal(later.total, 4);
    assert.equal(later.recent.installs, 0);

    assert.deepEqual(Object.fromEntries(counts.summaries(NOW)), { "acme/linear": { total: 4, recent: 2 }, "acme/notion": { total: 1, recent: 1 } });
    assert.deepEqual(counts.stats("acme/none", NOW), { total: 0, boxes: 0, recent: { days: 30, installs: 0, boxes: 0, daily: Array(30).fill(0) } });
  });

  it("checks a ping's shape before anything is kept", () => {
    const good = ping(1, 1);
    assert.equal(installPingProblem(good), undefined);
    assert.equal(installPingProblem({ ...good, commit: "a".repeat(40) }), undefined);
    assert.match(installPingProblem({ ...good, package: "Acme" })!, /publisher\/name/);
    assert.match(installPingProblem({ ...good, box: "short" })!, /32 hex/);
    assert.match(installPingProblem({ ...good, digest: "sha256:zz" })!, /digest/);
    assert.match(installPingProblem({ ...good, source: "file:/tmp/x" })!, /pk: or git\+/);
    assert.match(installPingProblem({ ...good, commit: "main" })!, /40 hex/);
    assert.match(installPingProblem({ ...good, ip: "1.2.3.4" })!, /"ip" is not a member/);
  });
});

describe("a box's install pings", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-pings-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("makes its id once and keeps it", async () => {
    const file = join(root, "packages", "box-id");
    const [a, b] = await Promise.all([boxIdOf(file), boxIdOf(file)]);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(b, a, "two first calls agree on one id");
    assert.equal(await boxIdOf(file), a);
    assert.equal((await readFile(file, "utf8")).trim(), a);
  });

  it("pings only the index that lists a package from where it was installed, for what the install wrote", async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const asked: string[] = [];
    const pings = createInstallPings({
      boxId: async () => BOX(7),
      // The index lists acme/* from these sources; nothing else.
      indexes: {
        listedAt: async (name, source) => {
          asked.push(`${name} ${source}`);
          return name.startsWith("acme/") && !source.includes("private") ? { index: "stakwork", base: "https://index.example" } : undefined;
        },
      },
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    });
    const report = (pkg: string, ref: string, status: PackageInstallReport["status"], commit?: string): PackageInstallReport => ({ package: pkg, version: "1.0.0", digest: DIGEST(3), source: { ref }, status, items: [], ...(commit ? { commit } : {}) });
    const result: InstallResult = {
      package: "acme/lander",
      digest: DIGEST(3),
      packages: [
        report("acme/linear", `pk:${"y".repeat(52)}/acme/linear`, "present"),
        report("acme/notion", `pk:${"y".repeat(52)}/acme/notion`, "updated"),
        report("acme/local", "file:/tmp/local", "installed"),
        report("acme/secret", "git+https://github.com/acme/private@main", "installed"),
        report("acme/lander", "git+https://github.com/acme/lander@main", "installed", "c".repeat(40)),
      ],
      missing: { secrets: [], binaries: [], runtimes: [] },
      warnings: [],
    };
    await pings.after(result);
    assert.deepEqual(asked.sort(), ["acme/lander git+https://github.com/acme/lander@main", `acme/notion pk:${"y".repeat(52)}/acme/notion`, "acme/secret git+https://github.com/acme/private@main"], "nothing present, nothing from a file");
    assert.deepEqual(
      sent.sort((a, b) => String(a.body["package"]).localeCompare(String(b.body["package"]))),
      [
        { url: "https://index.example/index/installs", body: { package: "acme/lander", box: BOX(7), digest: DIGEST(3), source: "git+https://github.com/acme/lander@main", commit: "c".repeat(40) } },
        { url: "https://index.example/index/installs", body: { package: "acme/notion", box: BOX(7), digest: DIGEST(3), source: `pk:${"y".repeat(52)}/acme/notion` } },
      ],
      "the private one never reaches the index",
    );
    // A failed ping is dropped: the install's result is not the ping's.
    const failing = createInstallPings({ boxId: async () => BOX(7), indexes: { listedAt: async () => ({ index: "x", base: "https://down.example" }) }, fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    await failing.after(result);
  });

  it("writes nothing for an install no index lists, and settles every ping before a close", async () => {
    let made = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const pings = createInstallPings({
      boxId: async () => (made++, BOX(7)),
      indexes: { listedAt: async (name) => (name === "acme/listed" ? { index: "x", base: "https://index.example" } : undefined) },
      fetch: (async () => (await held, new Response("{}", { status: 202 }))) as unknown as typeof fetch,
    });
    const only = (pkg: string, ref: string): InstallResult => ({ package: pkg, digest: DIGEST(1), packages: [{ package: pkg, version: "1.0.0", digest: DIGEST(1), source: { ref }, status: "installed", items: [] }], missing: { secrets: [], binaries: [], runtimes: [] }, warnings: [] });
    await pings.after(only("acme/local", "file:/tmp/local"));
    await pings.after(only("acme/other", `pk:${"y".repeat(52)}/acme/other`));
    assert.equal(made, 0, "no id is made, so nothing lands in the data dir, for a ping that never goes");
    let settled = false;
    void pings.after(only("acme/listed", `pk:${"y".repeat(52)}/acme/listed`));
    const closing = pings.settle().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, false, "a close waits for the ping on its way");
    release();
    await closing;
    assert.equal(made, 1);
  });
});

describe("a live server's run totals, as the index reads them", () => {
  it("keeps all time beside the last 30 days, and checks every number a stranger sent", () => {
    const item = { kind: "workflow", name: "greet", base: 0.05, markup: 0, capUsd: null, reserve: 0.05, results: "output" };
    const [read] = liveRunnableOf([{ ...item, recent: { days: 30, runs: 3, average: 0.05, charged: 0.15, daily: [0, 1, 2] }, total: { runs: 40, charged: 2 } }]);
    assert.deepEqual(read!.recent, { days: 30, runs: 3, average: 0.05, charged: 0.15, daily: [0, 1, 2] });
    assert.deepEqual(read!.total, { runs: 40, charged: 2 });
    // A server from before: recent as it was, no total.
    const [old] = liveRunnableOf([{ ...item, recent: { days: 30, runs: 3, average: 0.05 } }]);
    assert.deepEqual(old!.recent, { days: 30, runs: 3, average: 0.05 });
    assert.equal(old!.total, undefined);
    // Numbers that are not counts are dropped, never shown.
    const [bad] = liveRunnableOf([{ ...item, recent: { days: 30, runs: 3, average: 0.05, daily: [1, -2] }, total: { runs: "many", charged: 1 } }]);
    assert.equal(bad!.recent!.daily, undefined);
    assert.equal(bad!.total, undefined);
    assert.deepEqual(liveSalesOf({ sats: 1500, recent: { days: 30, sats: 300, daily: [0, 300] } }), { sats: 1500, recent: { days: 30, sats: 300, daily: [0, 300] } });
    assert.equal(liveSalesOf({ sats: -1, recent: { days: 30, sats: 0, daily: [] } }), undefined);
    assert.equal(liveSalesOf(undefined), undefined);
  });
});
