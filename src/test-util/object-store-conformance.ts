import { it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { ObjectStore } from "../object-store.js";

/**
 * The `ObjectStore` contract as tests: what the memory implementation and a
 * real S3-compatible store (the live suite) must both do. `prefix` keeps a
 * shared bucket's cases apart.
 */
export function objectStoreConformance(make: () => ObjectStore, prefix = "conformance"): void {
  const key = (name: string) => `${prefix}/${name}`;
  const bytesOf = async (body: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  };

  it("put, head and get give back the bytes that went in", async () => {
    const store = make();
    await store.put(key("a/hello.txt"), Readable.from([Buffer.from("hello "), Buffer.from("world")]));
    assert.deepEqual(await store.head(key("a/hello.txt")), { size: 11 });
    assert.equal((await bytesOf(await store.get(key("a/hello.txt")))).toString(), "hello world");
  });

  it("put replaces what is there, and an empty body is an object", async () => {
    const store = make();
    await store.put(key("b"), Readable.from([Buffer.from("first, and longer")]));
    await store.put(key("b"), Readable.from([Buffer.from("second")]));
    assert.equal((await bytesOf(await store.get(key("b")))).toString(), "second");
    await store.put(key("empty"), Readable.from([]));
    assert.deepEqual(await store.head(key("empty")), { size: 0 });
  });

  it("a body of unknown length larger than one upload part arrives whole", async () => {
    const store = make();
    // 12 MB that does not compress, in uneven chunks: more than two 5 MB parts.
    const chunks = Array.from({ length: 48 }, (_, i) => randomBytes(250_000 + (i % 3)));
    const whole = Buffer.concat(chunks);
    await store.put(key("big.bin"), Readable.from(chunks));
    assert.deepEqual(await store.head(key("big.bin")), { size: whole.length });
    assert.ok((await bytesOf(await store.get(key("big.bin")))).equals(whole));
  });

  it("a body that fails mid-stream fails the put and leaves no object", async () => {
    const store = make();
    async function* broken() {
      yield Buffer.from("some bytes");
      throw new Error("the source broke");
    }
    await assert.rejects(store.put(key("broken"), Readable.from(broken())));
    assert.equal(await store.head(key("broken")), null);
  });

  it("an object that is not there: head is null, get rejects, delete is quiet", async () => {
    const store = make();
    assert.equal(await store.head(key("nope")), null);
    await assert.rejects(store.get(key("nope")));
    await store.delete(key("nope"));
  });

  it("delete removes the object", async () => {
    const store = make();
    await store.put(key("gone"), Readable.from([Buffer.from("x")]));
    await store.delete(key("gone"));
    assert.equal(await store.head(key("gone")), null);
  });
}
