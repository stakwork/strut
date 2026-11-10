/**
 * The publisher's ASKS to be listed (plans/index-listing.md §1, §6) —
 * src/packages/publisher-listings.ts — over a stubbed index: what is kept
 * of each answer, and which indexes hear of a release. The whole flow over
 * two real servers is in ./index.test.ts.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageIndexes } from "./indexes.js";
import type { Listing } from "./listing.js";
import { createPublisherListings, type PublisherListings } from "./publisher-listings.js";
import type { Publisher } from "./publisher.js";

describe("the publisher's listings", () => {
  let root: string;
  let listings: PublisherListings;
  let calls: string[];
  let answer: () => Response;
  const pings = () => calls.filter((url) => url.endsWith("/index/ping")).length;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-listings-"));
    calls = [];
    answer = () => Response.json({ status: "listed", prefix: "acme" });
    listings = createPublisherListings({
      file: join(root, "listings.json"),
      indexes: { list: async () => [{ id: "stakwork", key: "i".repeat(52), urls: ["https://index.example/index/catalog"] }] } as unknown as PackageIndexes,
      publisher: { sealListing: async (fields: object) => ({ ...fields, v: 1, prefix: "acme", key: "k".repeat(52), seq: 1, sig: "0".repeat(128) }) as Listing } as unknown as Publisher,
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return String(input).endsWith("/index/ping") ? new Response("{}", { status: 202 }) : answer();
      }) as typeof fetch,
    });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("pings every index it asked, a failed or refused change included, until it takes itself off", async () => {
    const base = "https://acme1.sphinx.chat:3355/lab";
    await listings.ping("k".repeat(52));
    assert.equal(pings(), 0, "never asked: nothing to ping");

    assert.equal((await listings.ask("stakwork", { base })).record.status, "listed");
    await listings.ping("k".repeat(52));
    assert.deepEqual(calls, ["https://index.example/index/requests", "https://index.example/index/ping"]);

    // A change the index could not take: the record is that answer, and the row is still listed there.
    answer = () => Response.json({ error: "listing_no_catalog: a blip" }, { status: 422 });
    assert.equal((await listings.ask("stakwork", { base, description: "new words" })).record.status, "error");
    await listings.ping("k".repeat(52));
    assert.equal(pings(), 2);
    answer = () => Response.json({ error: "listing_refused: stay where you are" }, { status: 403 });
    assert.equal((await listings.ask("stakwork", { base: "https://acme2.sphinx.chat:3355/lab" })).record.status, "refused");
    await listings.ping("k".repeat(52));
    assert.equal(pings(), 3);

    // Taken off: no more pings.
    answer = () => Response.json({ status: "removed", prefix: "acme" });
    assert.equal((await listings.withdraw("stakwork")).record.status, "removed");
    await listings.ping("k".repeat(52));
    assert.equal(pings(), 3);
  });
});
