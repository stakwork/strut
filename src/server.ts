// Default strut server — a thin wrapper over createStrut() that keeps
// workflows/steps in Neo4j by default (see src/graph/wiring.ts; NEO4J_*
// vars, localhost:7687 when unset) while runs/chats/blobs stay under
// STRUT_WORKSPACE. Set STRUT_WORKSPACE_BACKEND=fs to boot with the
// filesystem-backed defaults instead (FileRunStore, workspace loaded from
// STRUT_WORKSPACE, registry built by scanning steps/) — no Neo4j needed.
//
// This file is the canonical "library usage" example: anything you
// see here, your own consumer code can do too. Pass your own
// `services`, your own in-code `registry`, your own store — and mount
// the returned `app` wherever you like (under another Hono router,
// behind Express, or just call `strut.listen(port)`).

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStrut, type Strut } from "./createStrut.js";
import { FileRunStore } from "./store.js";
import { FileChatStore } from "./chat-store.js";
import { FileSecretStore } from "./secret-store.js";
import { graphWorkspaceRequested } from "./graph/wiring.js";

let strutInstance: Strut | null = null;

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
    const llmAuth = mothership ? { llmAuth: mothership.llmAuth } : {};
    if (graphWorkspaceRequested()) {
      const { graphWorkspaceFromEnv } = await import("./graph/wiring.js");
      // dataDir keeps its file default (STRUT_WORKSPACE / ./workspace): runs,
      // chats, secrets, artifacts, cassettes, and the materialized custom
      // steps stay local. Explicit file stores, since a non-file workspace
      // would otherwise default to memory.
      const { backend, workspace } = await graphWorkspaceFromEnv(process.env, { dataDir });
      strutInstance = await createStrut({
        workspace,
        // Same backend for the chat builder's read-only graph_query tool.
        graph: backend,
        dataDir,
        store: new FileRunStore(dataDir),
        chatStore: new FileChatStore(dataDir),
        secretStore: new FileSecretStore(dataDir),
        ...llmAuth,
      });
    } else {
      strutInstance = await createStrut(llmAuth);
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
