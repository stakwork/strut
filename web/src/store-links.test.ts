import { test } from "node:test";
import assert from "node:assert/strict";
import { appsOf, canWords, conceptChildren, conceptRoots, indexIdOf, installLink, liveAppUrl, liveBase, normalizeStrutUrl, parseInstallLink, parseStoreView, storeQuery } from "./store-links";

const KEY = "y".repeat(52);

test("the store's view is read from the query and written back with store=1 kept", () => {
  assert.deepEqual(parseStoreView("?store=1"), { view: "browse" });
  assert.deepEqual(parseStoreView("?store=1&q=linear+issues"), { view: "browse", q: "linear issues" });
  assert.deepEqual(parseStoreView("?store=1&pkg=acme%2Flinear"), { view: "package", pkg: "acme/linear" });
  assert.deepEqual(parseStoreView("?store=1&pkg=Not%20A%20Name"), { view: "browse" }, "a pkg that is not a package name is ignored");
  assert.deepEqual(parseStoreView("?store=1&concept=Statute%20of%20limitations"), { view: "concept", concept: "Statute of limitations" });
  assert.deepEqual(parseStoreView("?store=1&concept="), { view: "concept", concept: "" }, "the tree's index");
  assert.equal(storeQuery({ view: "concept", concept: "" }), "?store=1&concept=");
  assert.equal(storeQuery({ view: "browse" }), "?store=1");
  assert.equal(storeQuery({ view: "browse", q: "a b" }), "?store=1&q=a+b");
  assert.equal(storeQuery({ view: "package", pkg: "acme/linear" }), "?store=1&pkg=acme%2Flinear");
  assert.equal(storeQuery({ view: "concept", concept: "Law" }), "?store=1&concept=Law");
  assert.deepEqual(parseStoreView(storeQuery({ view: "concept", concept: "Civil procedure" })), { view: "concept", concept: "Civil procedure" });
});

test("a live item's view: its publisher, its kind and its name, and the page it frames", () => {
  assert.deepEqual(parseStoreView("?store=1&live=openlaw&app=openlaw-benchmarks"), { view: "live", publisher: "openlaw", kind: "app", name: "openlaw-benchmarks" });
  assert.deepEqual(parseStoreView("?store=1&live=openlaw&workflow=openlaw-run"), { view: "live", publisher: "openlaw", kind: "workflow", name: "openlaw-run" });
  assert.deepEqual(parseStoreView("?store=1&live=Not%20A%20Prefix&app=x"), { view: "browse" }, "a publisher that is not a prefix is ignored");
  assert.deepEqual(parseStoreView("?store=1&live=openlaw"), { view: "browse" }, "a publisher with no item is the browse page");
  const v = { view: "live" as const, publisher: "acme", kind: "step" as const, name: "acme/linear/fetch" };
  assert.deepEqual(parseStoreView(storeQuery(v)), v);
  assert.equal(liveAppUrl("https://swarm.example:3355/lab/", "acme/bench"), "https://swarm.example:3355/lab/?app=acme%2Fbench&solo=1&public=1");
  assert.equal(liveBase({ live: { openlaw: { url: "https://s.example/lab/" } } }, "openlaw"), "https://s.example/lab");
  assert.equal(liveBase({ live: {} }, "constructor"), undefined, "own rows only");
  assert.equal(liveBase(null, "openlaw"), undefined);
});

test("a strut's address is normalized to its origin and mount", () => {
  assert.equal(normalizeStrutUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeStrutUrl("https://strut.acme.example/lab/"), "https://strut.acme.example/lab");
  assert.equal(normalizeStrutUrl("  https://x.example/?key=abc  "), "https://x.example", "a query is never kept");
  assert.equal(normalizeStrutUrl(""), null);
  assert.equal(normalizeStrutUrl("ftp://x"), null);
  assert.equal(normalizeStrutUrl("not a url at all"), null);
});

test("the install link carries the package, the index's key and its card's URL, and the shell reads it back", () => {
  const url = "https://index.example/index/catalog";
  const href = installLink("http://localhost:3000", { pkg: "acme/linear", index: { key: KEY, url } });
  assert.equal(href, `http://localhost:3000/?install=acme%2Flinear&index=${KEY}&index_url=${encodeURIComponent(url)}`);
  assert.deepEqual(parseInstallLink(new URL(href).search), { pkg: "acme/linear", index: { key: KEY, url } });
  assert.deepEqual(parseInstallLink("?install=acme%2Flinear"), { pkg: "acme/linear" });
  assert.deepEqual(parseInstallLink("?install=acme%2Flinear&index=nope&index_url=" + encodeURIComponent(url)), { pkg: "acme/linear" }, "a bad key drops the index, not the link");
  assert.deepEqual(parseInstallLink(`?install=acme%2Flinear&index=${KEY}`), { pkg: "acme/linear" }, "a key with no URL follows nothing");
  assert.equal(parseInstallLink("?install=Not%20A%20Name"), null);
  assert.equal(parseInstallLink("?store=1"), null);
  assert.equal(installLink("https://strut.acme.example/lab", { pkg: "acme/linear" }), "https://strut.acme.example/lab/?install=acme%2Flinear");
});

test("an index followed from a link is filed under its host", () => {
  assert.equal(indexIdOf("https://index.example/index/catalog"), "index-example");
  assert.equal(indexIdOf("http://localhost:3100/index/catalog"), "localhost-3100");
  assert.equal(indexIdOf("nope"), "index");
});

test("the apps across the hits come first, by title; the concept roots by how much sits under them", () => {
  const can = { spends: false, acts: false, code: false };
  const hits = [
    { package: "acme/linear", version: "1.4.0", detail: { apps: [{ name: "issues", title: "Linear Issues", can }, { name: "cycles", title: "Cycle Report", can }] } },
    { package: "acme/bare", version: "0.1.0" },
    { package: "openlaw/civil", version: "12", detail: { apps: [{ name: "deadlines", title: "Deadline Calculator", can }] } },
  ];
  assert.deepEqual(appsOf(hits).map((a) => `${a.app.title} (${a.pkg})`), ["Cycle Report (acme/linear)", "Deadline Calculator (openlaw/civil)", "Linear Issues (acme/linear)"]);
  const roots = conceptRoots([
    { name: "Law" },
    { name: "Civil procedure", parents: ["Law"] },
    { name: "Statute of limitations", parents: ["Civil procedure"] },
    { name: "Tolling", parents: ["Statute of limitations"] },
    { name: "Accounting" },
    { name: "Audit", parents: ["Nowhere", "Accounting"] },
    { name: "Orphan", parents: ["Nowhere"] },
  ]);
  assert.deepEqual(roots.map((r) => [r.root.name, r.pages]), [["Law", 3], ["Accounting", 1], ["Orphan", 0]], "a page with a parent in the list is no root, whichever of its parents it is");
  const kids = conceptChildren([
    { name: "Law" },
    { name: "Tax", parents: ["Law"] },
    { name: "Contracts", parents: ["Law"] },
    { name: "Indemnity", parents: ["Contracts", "Tax", "Tax", "Nowhere"] },
    { name: "Loop", parents: ["Loop"] },
  ]);
  assert.deepEqual([...kids].map(([p, list]) => [p, list.map((c) => c.name)]), [["Law", ["Contracts", "Tax"]], ["Contracts", ["Indemnity"]], ["Tax", ["Indemnity"]]], "sorted by name, under each parent once, never under a parent the list lacks or itself");
  assert.deepEqual(canWords(can), ["reads"]);
  assert.deepEqual(canWords({ spends: true, acts: true, code: false }), ["spends", "acts"]);
});
