import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryObjectStore, S3ObjectStore } from "./object-store.js";
import { objectStoreConformance } from "./test-util/object-store-conformance.js";

describe("MemoryObjectStore", () => {
  const store = new MemoryObjectStore();
  objectStoreConformance(() => store);
});

// The S3 implementation against a real store is the live suite
// (run-archive.live.test.ts, `npm run test:archive`).
describe("S3ObjectStore", () => {
  it("an endpoint nothing listens on fails each call in one line that names it", async () => {
    const store = new S3ObjectStore({ bucket: "b", region: "us-east-1", endpoint: "http://127.0.0.1:1", credentials: { accessKeyId: "k", secretAccessKey: "s" } });
    try {
      await assert.rejects(store.head("box/archive.json"), /^Error: S3 HEAD "box\/archive\.json" failed: .*ECONNREFUSED/);
    } finally {
      await store.close();
    }
  });
});
