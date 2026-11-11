import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visitorHeaders } from "./visitor-pay";

// One purse per server (./store-purse): a visitor's credit on one strut
// server — the store's Run form there, or its public app hosted by this UI
// (./remote-app) — is never sent to another, and a reload in the tab finds
// each again under its own key.

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe("a purse per server", () => {
  it("keeps each server's visit and credit apart, and finds them again after a reload", async () => {
    const storage = new MemoryStorage();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = storage;
    try {
      const { storePurse } = await import("./store-purse");
      const a = storePurse("https://acme.example");
      const b = storePurse("https://other.example/lab");
      assert.equal(storePurse("https://acme.example"), a, "one per server and page");
      assert.notEqual(a.purse.visit, b.purse.visit, "two visits");
      a.purse.credential = "macA:preA";
      a.save();
      assert.deepEqual(visitorHeaders(b.purse), { "x-strut-visit": b.purse.visit }, "acme's credit is never sent to the other");
      assert.equal(visitorHeaders(a.purse)["authorization"], "L402 macA:preA");
      // A reload in the tab: each key holds its own server's purse alone.
      const saved = JSON.parse(storage.getItem("strut.store.purse:https://acme.example")!) as { visit: string; credential?: string };
      assert.equal(saved.visit, a.purse.visit);
      assert.equal(saved.credential, "macA:preA");
      const other = JSON.parse(storage.getItem("strut.store.purse:https://other.example/lab")!) as { credential?: string };
      assert.equal(other.credential, undefined);
      // This strut's own visitor purse (`strut.visitor:<API_BASE>`) is another key again.
      assert.ok([...storage.data.keys()].every((k) => k.startsWith("strut.store.")));
    } finally {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});
