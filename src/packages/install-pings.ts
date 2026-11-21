/**
 * The box's side of INSTALL COUNTS (./index-installs.ts is the index's):
 * after an install or update writes a package, one small ping to the index
 * that lists it — `POST <index>/index/installs { package, box, digest,
 * source, commit? }` — so the store can show how many boxes took it. The
 * install itself never waits on it, and never changes because of it: the
 * box installs from the publisher's catalog or the package's repository,
 * as before.
 *
 * Only what the index already lists is told: a package whose followed
 * index lists it from where it was installed — its row's key for a `pk:`
 * source, its row's repository for a `git+` one (`PackageIndexes.listedAt`).
 * A package from a private repository, a `file:` one, or one no followed
 * index lists sends nothing, so the index never learns its name.
 *
 * `box` is a random id this box makes once (`boxIdOf`), never its address
 * or key. `STRUT_INDEX_PINGS=0` turns the pings off.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BOX_ID, type InstallPing } from "./index-installs.js";
import type { PackageIndexes } from "./indexes.js";
import type { InstallResult } from "./install.js";

/** `<dataDir>/packages/box-id`: the id a box's pings carry. */
export const BOX_ID_FILE = "box-id";

const PING_TIMEOUT_MS = 10_000;

/** The box's id from `file`, made the first time it is asked for. */
export async function boxIdOf(file: string): Promise<string> {
  try {
    const id = (await readFile(file, "utf8")).trim();
    if (BOX_ID.test(id)) return id;
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const id = randomBytes(16).toString("hex");
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, `${id}\n`, { flag: "wx", mode: 0o600 });
    return id;
  } catch (err: any) {
    // Another call made it first: that one is the box's.
    if (err?.code === "EEXIST") return (await readFile(file, "utf8")).trim();
    throw err;
  }
}

export interface InstallPingsDeps {
  indexes: Pick<PackageIndexes, "listedAt">;
  boxId(): Promise<string>;
  /** Where an install's recorded ref really reads from: a subscription
   *  installs as `subscription:<id>` (a bundle's part as
   *  `subscription:<bundle>/<part>`), and this names the `git+` branch or
   *  the `pk:` catalog it follows. Absent: the ref as recorded. */
  sourceOf?(ref: string, pkg: string): Promise<string | undefined>;
  fetch?: typeof fetch;
}

export interface InstallPings {
  /** The pings an install's result calls for: every package it wrote that a
   *  followed index lists from that source. Each goes on its own; a failure
   *  is dropped (a count, never the install's business). */
  after(result: InstallResult): Promise<void>;
  /** Every ping still on its way, settled: what `close()` waits for, so
   *  nothing is written after the strut is closed. */
  settle(): Promise<void>;
}

export function createInstallPings(deps: InstallPingsDeps): InstallPings {
  const doFetch = deps.fetch ?? fetch;
  const pending = new Set<Promise<unknown>>();
  // The id is made only once a ping goes: a box that never pings writes nothing.
  let box: Promise<string> | undefined;
  const send = async (result: InstallResult): Promise<void> => {
    const written = result.packages.filter((p) => p.status !== "present");
    await Promise.allSettled(
      written.map(async (p) => {
        const source = deps.sourceOf ? await deps.sourceOf(p.source.ref, p.package) : p.source.ref;
        if (!source || !/^(pk:|git\+)/.test(source)) return;
        const at = await deps.indexes.listedAt(p.package, source);
        if (!at) return;
        box ??= deps.boxId().catch((err: unknown) => {
          box = undefined;
          throw err;
        });
        const ping: InstallPing = { package: p.package, box: await box, digest: p.digest, source, ...(p.commit ? { commit: p.commit } : {}) };
        const res = await doFetch(`${at.base}/index/installs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ping), signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
        await res.body?.cancel();
      }),
    );
  };
  return {
    after(result) {
      const p = send(result).catch(() => undefined);
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },
    async settle() {
      await Promise.allSettled([...pending]);
    },
  };
}
