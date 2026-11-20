import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cspFor } from "../../src/apps/build.js";
import { strutLink } from "./app-links";
import { APP_CSP, remoteAppHref, remoteAppLink, remoteBase, remoteHere, strangerDocument } from "./remote-app";
import { pickPage } from "./page";

// Another strut server's public app with this UI as its host (./remote-app,
// specs/API.md §17.9): the link, the server it names, and how its page's
// links and document are read here.

describe("a remote public app's link", () => {
  it("names the server by its base URL, normalized as a seller's", () => {
    assert.deepEqual(remoteBase("https://acme.example"), { base: "https://acme.example" });
    assert.deepEqual(remoteBase("https://acme.example/"), { base: "https://acme.example" });
    assert.deepEqual(remoteBase(" https://swarm.example:3355/lab/ "), { base: "https://swarm.example:3355/lab" });
    assert.deepEqual(remoteBase("https://acme.example/lab/public"), { base: "https://acme.example/lab" });
    assert.deepEqual(remoteBase("https://acme.example/public/"), { base: "https://acme.example" });
    // A query or fragment is no part of a server's address.
    assert.deepEqual(remoteBase("https://acme.example/lab?x=1#y"), { base: "https://acme.example/lab" });
    // http only on this machine: a development pair.
    assert.deepEqual(remoteBase("http://localhost:3001"), { base: "http://localhost:3001" });
    assert.deepEqual(remoteBase("http://127.0.0.1:4411/"), { base: "http://127.0.0.1:4411" });
  });

  it("refuses what is not a server this host opens", () => {
    for (const [raw, why] of [
      ["http://acme.example", /not https/],
      ["http://192.168.1.20:3000", /not https/],
      ["https://me:secret@acme.example", /no credentials/],
      ["ftp://acme.example", /not a strut server/],
      ["acme.example", /not a URL/],
      ["", /names no server/],
    ] as const) {
      const r = remoteBase(raw);
      assert.ok("error" in r, raw);
      if ("error" in r) assert.match(r.error, why, raw);
    }
  });

  it("builds the link a strut UI opens it with, and nothing that is a credential", () => {
    const href = remoteAppHref("http://localhost:3000/", { from: "https://acme.example/lab", name: "acme/voxel/studio", input: "view=/runs" });
    assert.equal(href, "http://localhost:3000/?app=acme%2Fvoxel%2Fstudio&public=1&from=https%3A%2F%2Facme.example%2Flab&solo=1&input=view%3D%2Fruns");
    const page = pickPage(new URL(href).search, null);
    assert.deepEqual(page, { kind: "app", app: "acme/voxel/studio", input: "view=/runs", visitor: true, from: "https://acme.example/lab" });
  });

  it("opens alone for anyone — solo and public implied — and never falls back to an app of the same name here", () => {
    for (const session of [null, {}, { role: "admin" as const }, { role: "member" as const }]) {
      assert.deepEqual(pickPage("?app=voxel&from=https%3A%2F%2Facme.example&theme=light", session), {
        kind: "app", app: "voxel", input: null, visitor: true, from: "https://acme.example", theme: "light",
      });
    }
    const refused = pickPage("?app=voxel&public=1&solo=1&from=http%3A%2F%2Facme.example", null);
    assert.equal(refused.kind, "refused");
    assert.match((refused as { message: string }).message, /^Not opened: .*not https/);
    // A served box shows its own app, whatever the link names.
    assert.equal(pickPage("?app=voxel&from=https%3A%2F%2Facme.example", null, { app: "site", key: false }).kind, "app");
    assert.equal((pickPage("?app=voxel&from=https%3A%2F%2Facme.example", null, { app: "site", key: false }) as { app: string }).app, "site");
  });

  it("reads the page's links against ITS server: an app there is never one of this strut's", () => {
    const here = remoteHere("https://acme.example/lab");
    assert.deepEqual(here, { origin: "https://acme.example", pathname: "/lab/" });
    assert.deepEqual(strutLink("?app=voxel&input=a%3D1", here), { app: "voxel", input: "a=1" });
    assert.deepEqual(strutLink("https://acme.example/lab/?app=other", here), { app: "other" });
    // A link into THIS strut (where the page is hosted) is not the page's server.
    assert.equal(strutLink("http://localhost:3000/?install=evil%2Fpkg", here), null);
    assert.deepEqual(remoteHere("https://acme.example"), { origin: "https://acme.example", pathname: "/" });
  });

  it("a link to another app on that server stays in THIS host — never the server's own UI", () => {
    const params = strutLink("?app=voxel%2Feditor&input=scene%3D3", remoteHere("https://acme.example/lab"))!;
    assert.equal(
      remoteAppLink(params, "https://acme.example/lab", "http://127.0.0.1:4410/"),
      "http://127.0.0.1:4410/?app=voxel%2Feditor&public=1&from=https%3A%2F%2Facme.example%2Flab&solo=1&input=scene%3D3",
    );
    // A workflow, a run, a file, another peer's app, a pinned version: opened on the server as a page.
    assert.equal(remoteAppLink({ wf: "x" }, "https://acme.example", "http://h/"), null);
    assert.equal(remoteAppLink({ app: "@peer/x" }, "https://acme.example", "http://h/"), null);
    assert.equal(remoteAppLink({ app: "x@v3" }, "https://acme.example", "http://h/"), null);
  });
});

describe("a stranger's document", () => {
  it("is held to the build's own CSP, written ahead of anything the server sent", () => {
    assert.equal(APP_CSP, cspFor(), "the CSP every app's build writes");
    const doc = strangerDocument("<!doctype html>\n<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"></head><body></body></html>");
    assert.ok(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${APP_CSP}">`));
    assert.ok(doc.indexOf(APP_CSP) < doc.indexOf("default-src *"));
  });
});
