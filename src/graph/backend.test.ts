import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "../createStrut.js";
import { coreRegistry } from "../steps/registry.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { openGraphBackend } from "./backend.js";
import { testBackends } from "./test-util.js";

const ping = (b: { query: (c: string) => Promise<unknown[]> }) => b.query("RETURN 1 AS one");

for (const tb of testBackends()) {
  describe(`openGraphBackend handles (${tb.name})`, { skip: tb.skip }, () => {
    // 2026-10-28, swarm38: a builder-authored step opened the deployment's
    // own graph, got the shared connection, and closed it at the end — the
    // workspace, claims and projector then failed "Pool is closed".
    it("a handle's close() leaves the connection open while another handle holds it", async () => {
      const first = await tb.open();
      const second = await openGraphBackend(first.cfg, { embeddings: false, skipBoot: true });
      try {
        await second.close();
        await second.close(); // twice is once
        assert.deepEqual(await ping(first), [{ one: 1 }]);
        // A later open of the same config still shares the live connection.
        const third = await openGraphBackend(first.cfg, { embeddings: false, skipBoot: true });
        await third.close();
        assert.deepEqual(await ping(first), [{ one: 1 }]);
      } finally {
        await tb.close(first);
      }
      // The last handle closed it.
      await assert.rejects(ping(first));
    });

    it("ctx.services.graph cannot close the backend the server wired", async () => {
      const b = await tb.open();
      const dir = await mkdtemp(join(tmpdir(), "strut-backend-lend-"));
      try {
        const strut = await createStrut({
          workspace: new FileWorkspaceStore(dir),
          dataDir: dir,
          registry: coreRegistry(),
          store: new MemoryRunStore(),
          graph: b,
          serveUi: false,
          enableChat: false,
          claims: false,
          concepts: false,
          stt: false,
          scheduler: false,
        });
        const lent = (strut.services as { graph?: { close(): Promise<void> } }).graph;
        assert.ok(lent);
        await lent.close();
        assert.deepEqual(await ping(b), [{ one: 1 }]);
        await strut.close();
      } finally {
        await tb.close(b);
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
