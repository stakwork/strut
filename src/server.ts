// Default strut server — a thin wrapper over createStrut() that keeps
// workflows/steps in a graph by default (see src/graph/wiring.ts): Neo4j
// (NEO4J_* vars, localhost:7687 when unset), or with
// STRUT_WORKSPACE_BACKEND=ladybug one LadybugDB file under STRUT_WORKSPACE
// (plans/ladybug-backend.md — the desktop's backend, no daemon). Runs, chats
// and blobs stay under STRUT_WORKSPACE either way. Set
// STRUT_WORKSPACE_BACKEND=fs to boot with the filesystem-backed defaults
// instead (FileRunStore, workspace loaded from STRUT_WORKSPACE, registry
// built by scanning steps/) — no graph at all. STRUT_HOST_CONFIG names a
// JSON file with the host's delta for the workflows strut ships —
// `{ job?, orchestrator? }`, each `{ tools?, system? }` as createStrut takes
// it, and `automation?: { workflow, approve?, grants? }` for the automation/* steps —
// for a host that runs this server rather than embedding createStrut (Peel
// writes it at launch).
//
// This file is the canonical "library usage" example: anything you
// see here, your own consumer code can do too. Pass your own
// `services`, your own in-code `registry`, your own store — and mount
// the returned `app` wherever you like (under another Hono router,
// behind Express, or just call `strut.listen(port)`).

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStrut, type Strut, type StrutOptions } from "./createStrut.js";
import { FileRunStore } from "./store.js";
import { FileChatStore } from "./chat-store.js";
import { FileSecretStore } from "./secret-store.js";
import { workspaceBackendFromEnv } from "./graph/wiring.js";

let strutInstance: Strut | null = null;

/** The host's delta for the shipped workflows, from the JSON file
 *  `STRUT_HOST_CONFIG` names: `{ job?, orchestrator? }`, each `{ tools?,
 *  system? }`, and `automation?: { workflow, approve?, grants? }`. Nothing when unset. A file that cannot be read or parsed
 *  fails the boot, rather than seeding the workflows without the host's
 *  tools. */
export function hostConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<StrutOptions, "job" | "orchestrator" | "automation"> {
  const file = env["STRUT_HOST_CONFIG"];
  if (!file) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`STRUT_HOST_CONFIG: could not read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  const out: Pick<StrutOptions, "job" | "orchestrator" | "automation"> = {};
  for (const key of ["job", "orchestrator"] as const) {
    const delta = (raw as Record<string, unknown> | null)?.[key];
    if (delta === undefined) continue;
    const { tools, system, model } = (delta ?? {}) as { tools?: unknown; system?: unknown; model?: unknown };
    if (
      (tools !== undefined && !(Array.isArray(tools) && tools.every((t) => typeof t === "string"))) ||
      (system !== undefined && typeof system !== "string") ||
      (model !== undefined && model !== null && typeof model !== "string")
    ) {
      throw new Error(`STRUT_HOST_CONFIG: ${file}: "${key}" must be { tools?: string[], system?: string, model?: string | null }`);
    }
    out[key] = {
      ...(tools ? { tools: tools as string[] } : {}),
      ...(system !== undefined ? { system: system as string } : {}),
      ...(model !== undefined ? { model: model as string | null } : {}),
    };
  }
  const automation = (raw as Record<string, unknown> | null)?.["automation"];
  if (automation !== undefined) {
    const { workflow, approve, grants } = (automation ?? {}) as { workflow?: unknown; approve?: unknown; grants?: unknown };
    if (
      typeof workflow !== "string" || !workflow ||
      (approve !== undefined && typeof approve !== "string") ||
      (grants !== undefined && typeof grants !== "boolean")
    ) {
      throw new Error(`STRUT_HOST_CONFIG: ${file}: "automation" must be { workflow: string, approve?: string, grants?: boolean }`);
    }
    out.automation = {
      workflow,
      ...(approve !== undefined ? { approve: approve as string } : {}),
      ...(grants !== undefined ? { grants: grants as boolean } : {}),
    };
  }
  return out;
}

/** Lazily build the default Strut instance. Kept lazy so importing this
 *  module doesn't kick off filesystem I/O at module-load time. */
async function getDefault(): Promise<Strut> {
  if (!strutInstance) {
    // STRUT_MOTHERSHIP=1 routes every LLM call through the stakgraph gateway
    // with a per-actor macaroon (src/mothership.ts); delegations arrive via
    // PUT /llm/delegations/:actor.
    const dataDir = process.env["STRUT_WORKSPACE"] ?? "./workspace";
    const mothership =
      process.env["STRUT_MOTHERSHIP"] === "1"
        ? (await import("./mothership.js")).createMothership({ dataDir })
        : null;
    const shared: Pick<StrutOptions, "llmAuth" | "publicUrl" | "job" | "orchestrator" | "automation"> = {
      ...(mothership ? { llmAuth: mothership.llmAuth } : {}),
      // Where a caller outside the UI (the MCP door) is told this server
      // is; else each request's own origin.
      ...(process.env["STRUT_PUBLIC_URL"] ? { publicUrl: process.env["STRUT_PUBLIC_URL"] } : {}),
      // The host's delta for the shipped workflows (STRUT_HOST_CONFIG).
      ...hostConfigFromEnv(),
    };
    // dataDir keeps its file default (STRUT_WORKSPACE / ./workspace) on a
    // graph workspace: runs, chats, secrets, artifacts, cassettes, and the
    // materialized custom steps stay local. Explicit file stores, since a
    // non-file workspace would otherwise default to memory.
    const fileStores = () => ({
      dataDir,
      store: new FileRunStore(dataDir),
      chatStore: new FileChatStore(dataDir),
      secretStore: new FileSecretStore(dataDir),
    });
    const kind = workspaceBackendFromEnv();
    if (kind === "ladybug") {
      const { ladybugWorkspaceFromEnv } = await import("./graph/wiring.js");
      const { backend, workspace, imported } = await ladybugWorkspaceFromEnv(process.env, { dataDir });
      if (imported.status === "failed") {
        // The flip to the file happens only once the import succeeds
        // (plans/ladybug-backend.md §7.1): until then the filesystem
        // workspace, every file where it was, is what this server serves.
        console.error(
          `[graph] the filesystem workspace under ${dataDir} could not be imported into ${backend.cfg.path}: ${imported.error}\n` +
            `[graph] booting on the filesystem workspace instead (nothing was moved); the import runs again at the next boot`,
        );
        await backend.close();
        strutInstance = await createStrut(shared);
      } else {
        strutInstance = await createStrut({ workspace, graph: backend, ...fileStores(), ...shared });
      }
    } else if (kind === "neo4j") {
      const { graphWorkspaceFromEnv } = await import("./graph/wiring.js");
      const { backend, workspace } = await graphWorkspaceFromEnv(process.env, { dataDir });
      strutInstance = await createStrut({ workspace, graph: backend, ...fileStores(), ...shared });
    } else {
      strutInstance = await createStrut(shared);
    }
    mothership?.mount(strutInstance);
  }
  return strutInstance;
}

/**
 * Hono app for the default strut. Returns the same
 * instance on repeated calls. Most code should call `createStrut()`
 * directly and mount `strut.app` — this helper exists for ergonomic
 * scripting and backwards compatibility.
 */
export async function getApp() {
  return (await getDefault()).app;
}

/**
 * Boot the default strut server on `port` (defaults to
 * `STRUT_PORT` or `3000`). Equivalent to:
 *
 * ```ts
 * const strut = await createStrut();
 * await strut.listen(port);
 * ```
 */
export async function startServer(port?: number, host?: string): Promise<number> {
  const strut = await getDefault();
  return strut.listen(port, host);
}

/** True only when THIS file is the process entry — `tsx src/server.ts`,
 *  `node build/server.js`, or a symlink to either — decided by comparing
 *  the entry's canonical path with this module's own. A name check
 *  (`endsWith("server.js")`) once booted the default server inside any HOST
 *  whose own entry was called `server.js` and imported the barrel, before
 *  the host's createStrut() ran (EADDRINUSE on :3000, or worse, a healthy
 *  container serving the wrong strut). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const canonical = (p: string) => {
    const abs = path.resolve(p);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  };
  return canonical(entry) === canonical(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  startServer();
}
