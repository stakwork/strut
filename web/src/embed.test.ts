import { test } from "node:test";
import assert from "node:assert/strict";
import { deepLinkParams, embedPage, openInHost, vouchedEmbedOrigin } from "./embed";

test("deepLinkParams keeps only the deep-link keys", () => {
  assert.deepEqual(
    deepLinkParams("?wf=clip&run=123&v=v2&chat=c1&key=secret&embed_origin=https://hive.test&x=1"),
    { wf: "clip", run: "123", v: "v2", chat: "c1" },
  );
});

test("deepLinkParams carries an app and what it is opened with", () => {
  assert.deepEqual(deepLinkParams("?app=bench&input=view%3D%252Fruns&solo=1"), { app: "bench", input: "view=%2Fruns" });
});

test("deepLinkParams carries the builder's open question", () => {
  assert.deepEqual(deepLinkParams("?chat=c1&elicit=e1"), { chat: "c1", elicit: "e1" });
});

test("deepLinkParams drops empty values", () => {
  assert.deepEqual(deepLinkParams("?wf=&run=5"), { run: "5" });
  assert.deepEqual(deepLinkParams(""), {});
});

test("embedPage is the framing host's own page, on the origin that asked for reports", () => {
  const host = "https://box.test";
  assert.equal(embedPage("?app=strut%2Fjamie&embed_page=https%3A%2F%2Fbox.test%2F", true, host), "https://box.test/");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fbox.test%2Fapps%2Fbench", true, host), "https://box.test/apps/bench");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fbox.test%2F", false, host), undefined, "not framed: no host page");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fevil.test%2F", true, host), undefined, "another site's page");
  assert.equal(embedPage("?embed_page=https%3A%2F%2Fbox.test%2F", true, null), undefined, "no host asked for reports");
  assert.equal(embedPage("?embed_page=not%20a%20url", true, host), undefined);
  assert.equal(embedPage("?app=x", true, host), undefined);
  assert.equal(deepLinkParams("?app=x&embed_page=https%3A%2F%2Fbox.test%2F").embed_page, undefined, "never a deep-link param");
});

test("by default embedPage takes the origin the server vouched for (its meta), never the embed_origin a page names", () => {
  const saved = (globalThis as { document?: unknown }).document;
  /** A document whose `<meta name="strut-embed-origin">` says `content` (undefined: no meta). */
  const withMeta = (content: string | undefined) => {
    (globalThis as { document?: unknown }).document = {
      querySelector: (sel: string) => (sel === 'meta[name="strut-embed-origin"]' && content !== undefined ? { getAttribute: () => content } : null),
    };
  };
  try {
    // A host's frame: the server saw its ticket and vouches for its origin.
    withMeta("https://box.test");
    assert.equal(vouchedEmbedOrigin(), "https://box.test");
    assert.equal(embedPage("?app=x&embed_origin=https%3A%2F%2Fbox.test&embed_page=https%3A%2F%2Fbox.test%2Fapps%2Fx", true), "https://box.test/apps/x");
    assert.equal(embedPage("?app=x&embed_origin=https%3A%2F%2Fevil.test&embed_page=https%3A%2F%2Fevil.test%2Fphish", true), undefined, "a page on another origin");
    // A neighbour's frame (or a crafted link): no ticket, so the server vouched for none.
    withMeta("");
    assert.equal(embedPage("?app=x&embed_origin=https%3A%2F%2Fevil.test&embed_page=https%3A%2F%2Fevil.test%2Fphish", true), undefined);
    // A strut with no key of its own (behind a host's gate) writes no meta: no host page either.
    withMeta(undefined);
    assert.equal(vouchedEmbedOrigin(), undefined);
    assert.equal(embedPage("?app=x&embed_origin=https%3A%2F%2Fhive.test&embed_page=https%3A%2F%2Fhive.test%2F", true), undefined);
  } finally {
    (globalThis as { document?: unknown }).document = saved;
  }
});

test("openInHost posts strut:open to the framing host's vouched origin only; false with no host to ask", () => {
  const g = globalThis as { window?: unknown; document?: unknown };
  const saved = { window: g.window, document: g.document };
  const posts: [unknown, string][] = [];
  const parent = { postMessage: (msg: unknown, origin: string) => posts.push([msg, origin]) };
  const withMeta = (content: string) => {
    g.document = { querySelector: (sel: string) => (sel === 'meta[name="strut-embed-origin"]' ? { getAttribute: () => content } : null) };
  };
  try {
    g.window = { parent };
    withMeta("https://box.test");
    assert.equal(openInHost({ app: "strut/jamie", input: "session=ann%2Fabc" }), true);
    assert.equal(openInHost({ app: "strut/jamie" }), true);
    assert.deepEqual(posts, [
      [{ type: "strut:open", app: "strut/jamie", input: "session=ann%2Fabc" }, "https://box.test"],
      [{ type: "strut:open", app: "strut/jamie" }, "https://box.test"],
    ]);
    // Framed, but the server vouched for no host: nothing posted.
    withMeta("");
    assert.equal(openInHost({ app: "strut/jamie" }), false);
    // Not framed (Peel's web view): the page goes there itself.
    const self: { parent?: unknown } = {};
    self.parent = self;
    g.window = self;
    withMeta("https://box.test");
    assert.equal(openInHost({ app: "strut/jamie" }), false);
    assert.equal(posts.length, 2);
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
});
