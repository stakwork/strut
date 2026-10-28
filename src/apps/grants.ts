/**
 * An app's grants of SEALED workflows: what a person allowed beyond its
 * manifest. A sealed workflow — the `orchestrator`, the person's assistant
 * — is nothing a model-written manifest may grant (apps.ts
 * `refusedGrants`), and nothing `run/*` reaches (createStrut's `openFlow`).
 * A person lifts that for ONE app and ONE workflow: through `app/grant`,
 * which runs only as a proposal they accepted, or `POST /apps/:name/grants`.
 * Then the builder's publishes may name the workflow in `grants.workflows`,
 * and the app's pages launch it as their viewer — with no prompt at use:
 * the friction is at creation.
 *
 * Kept on the app's NAME, not a version: a grant may come before the first
 * publish (the builder's publish is what asks for it), and every later
 * version keeps it while its manifest still names the workflow. Under
 * dataDir on every backend, like the version directories: one JSON file,
 * `<dataDir>/app-grants.json`, written whole through a rename.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withLock } from "../jobs.js";

export interface AppGrant {
  /** The sealed workflow the app's pages may launch and read their runs of. */
  workflow: string;
  at: string;
  /** The person who allowed it: the proposal's decider, or the route's actor. */
  by?: string;
  /** The accepted proposal it came from. */
  proposal?: string;
}

export interface AppGrantStore {
  /** The app's grants, oldest first. */
  list(app: string): Promise<AppGrant[]>;
  has(app: string, workflow: string): Promise<boolean>;
  /** Record a grant; one already there is replaced (who, when). */
  add(app: string, grant: AppGrant): Promise<AppGrant>;
  /** False when there was none. */
  remove(app: string, workflow: string): Promise<boolean>;
  /** Every grant of an app — when the app is deleted, so a new app of the
   *  same name starts with none. */
  removeAll(app: string): Promise<void>;
}

type Table = Record<string, AppGrant[]>;

export const APP_GRANTS_FILE = "app-grants.json";

/** The grants under `dataDir`, one file for every app. */
export function fileAppGrants(dataDir: string): AppGrantStore {
  const file = join(dataDir, APP_GRANTS_FILE);
  const read = async (): Promise<Table> => {
    try {
      return JSON.parse(await readFile(file, "utf-8")) as Table;
    } catch (err: any) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  };
  const write = async (t: Table) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(t, null, 2));
    await rename(`${file}.tmp`, file);
  };
  const edit = <T>(fn: (t: Table) => T) =>
    withLock(`app-grants:${file}`, async () => {
      const t = await read();
      const out = fn(t);
      await write(t);
      return out;
    });
  return tableStore(read, edit);
}

/** In memory: a deployment with no data directory, and tests. */
export function memoryAppGrants(): AppGrantStore {
  const t: Table = {};
  return tableStore(
    async () => t,
    async (fn) => fn(t),
  );
}

function tableStore(read: () => Promise<Table>, edit: <T>(fn: (t: Table) => T) => Promise<T>): AppGrantStore {
  return {
    async list(app) {
      return [...((await read())[app] ?? [])];
    },
    async has(app, workflow) {
      return ((await read())[app] ?? []).some((g) => g.workflow === workflow);
    },
    add(app, grant) {
      return edit((t) => {
        t[app] = [...(t[app] ?? []).filter((g) => g.workflow !== grant.workflow), grant];
        return grant;
      });
    },
    remove(app, workflow) {
      return edit((t) => {
        const before = t[app] ?? [];
        const after = before.filter((g) => g.workflow !== workflow);
        if (after.length) t[app] = after;
        else delete t[app];
        return after.length !== before.length;
      });
    },
    async removeAll(app) {
      await edit((t) => {
        delete t[app];
      });
    },
  };
}
