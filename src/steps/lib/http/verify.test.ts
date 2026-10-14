/** `http/verify` — the endpoint instrument (plans/job-claims.md §4), over a local server. */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { httpCapability } from "../../../capabilities.js";
import { mapCheckResult } from "../../../verify.js";
import verify, { atPath, evaluate } from "./verify.js";

let server: Server;
let base: string;
/** What the last request to /echo carried — the proof a secret reached the wire. */
let lastHeaders: IncomingHttpHeaders = {};

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    switch (path) {
      case "/ok":
        res.writeHead(200, { "content-type": "application/json", "x-trace": "abc-123" });
        res.end(JSON.stringify({ settings: { notifications: { email: true, sms: false } }, list: [1, { n: 2 }], text: "notifications on" }));
        return;
      case "/fail":
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom: the database is down");
        return;
      case "/missing":
        res.writeHead(404);
        res.end("no such page");
        return;
      case "/html":
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>hello world</h1>");
        return;
      case "/slow":
        setTimeout(() => {
          res.writeHead(200);
          res.end("late");
        }, 120);
        return;
      case "/hang":
        return; // never answers
      case "/echo":
        lastHeaders = req.headers;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null, cookie: req.headers["x-cookie"] ?? null, method: req.method }));
        return;
      default:
        res.writeHead(204);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const ctxWith = (secrets: Record<string, string> = {}) =>
  ({
    runId: "t",
    path: "t",
    scope: {},
    input: {},
    emit: async () => {},
    services: { http: httpCapability(), secrets: { get: async (n: string) => secrets[n] } },
  }) as never;

const run = (cfg: Record<string, unknown>, secrets?: Record<string, string>) => verify.run(verify.input.parse(cfg), ctxWith(secrets));

describe("http/verify", () => {
  it("a 2xx with no expect supports; the output is the check contract with the measurement beside it", async () => {
    const out = await run({ url: `${base}/ok` });
    assert.equal(out.supports, true);
    assert.deepEqual([out.status, out.failed, out.locator], [200, [], { url: `${base}/ok` }]);
    assert.ok(Number.isInteger(out.ms) && out.ms >= 0);
    assert.match(out.content, /^GET http:\/\/127\.0\.0\.1:\d+\/ok → 200 in \d+ ms, ok; body: \{"settings":\{"notifications"/);
    // What the verify pass reads off it: evidence, as the step said.
    assert.deepEqual(mapCheckResult("http/verify", { status: "success", output: out }), { kind: "evidence", supports: true, content: out.content, locator: { url: `${base}/ok` } });
  });

  it("a status that is not the expected one is a RESULT, a 500 included — never a throw", async () => {
    const out = await run({ url: `${base}/fail`, expect: { status: 200 } });
    assert.equal(out.supports, false);
    assert.deepEqual([out.status, out.failed], [500, ["status 500, expected 200"]]);
    assert.match(out.content, /→ 500 in \d+ ms, 1 of 1 expectation failed: status 500, expected 200; body: boom: the database is down$/);
    assert.equal(mapCheckResult("http/verify", { status: "success", output: out }).kind, "evidence");

    const notFound = await run({ url: `${base}/missing` });
    assert.deepEqual([notFound.supports, notFound.failed], [false, ["status 404, expected 2xx"]]);

    const either = await run({ url: `${base}/ok`, expect: { status: [204, 200] } });
    assert.equal(either.supports, true);
    const neither = await run({ url: `${base}/ok`, expect: { status: [201, 204] } });
    assert.deepEqual(neither.failed, ["status 200, expected 201 or 204"]);
  });

  it("contains: each a substring of the body", async () => {
    assert.equal((await run({ url: `${base}/ok`, expect: { contains: ["notifications", '"email":true'] } })).supports, true);
    const out = await run({ url: `${base}/ok`, expect: { contains: ["notifications", "nope"] } });
    assert.deepEqual([out.supports, out.failed], [false, ['body does not contain "nope"']]);
    assert.match(out.content, /1 of 3 expectations failed/);
  });

  it("json: a dot path into the parsed body, deep-equal (key order free, types strict); a body that is not JSON fails them all", async () => {
    const pass = await run({
      url: `${base}/ok`,
      expect: { json: { "settings.notifications.email": true, "list.1.n": 2, "settings.notifications": { sms: false, email: true }, "list.0": 1 } },
    });
    assert.deepEqual([pass.supports, pass.failed], [true, []]);
    const fail = await run({ url: `${base}/ok`, expect: { json: { "settings.notifications.email": false, "settings.missing": 1, "list.1.n": "2" } } });
    assert.deepEqual(fail.failed, [
      "json settings.notifications.email is true, expected false",
      "json settings.missing is missing, expected 1",
      'json list.1.n is 2, expected "2"',
    ]);
    const html = await run({ url: `${base}/html`, expect: { json: { "a.b": 1 } } });
    assert.deepEqual(html.failed, ["body is not JSON (a.b)"]);
  });

  it("headers: a substring of the value, names case-insensitive", async () => {
    assert.equal((await run({ url: `${base}/ok`, expect: { headers: { "Content-Type": "application/json", "X-TRACE": "abc" } } })).supports, true);
    const out = await run({ url: `${base}/ok`, expect: { headers: { "content-type": "text/html", "x-nope": "x" } } });
    assert.deepEqual(out.failed, ['header content-type "application/json" does not contain "text/html"', 'header x-nope missing, expected to contain "x"']);
  });

  it("maxMs: the answer must arrive in time — a late one is a result, with its status", async () => {
    assert.equal((await run({ url: `${base}/ok`, expect: { maxMs: 10_000 } })).supports, true);
    const out = await run({ url: `${base}/slow`, expect: { maxMs: 20 } });
    assert.equal(out.status, 200);
    assert.equal(out.supports, false);
    assert.match(out.failed[0]!, /^took \d+ ms, expected at most 20 ms$/);
  });

  it("the method and the body go out as given", async () => {
    const out = await run({ url: `${base}/echo`, method: "POST", body: { a: 1 }, expect: { json: { method: "POST" } } });
    assert.equal(out.supports, true);
    assert.equal(lastHeaders["content-type"], "application/json");
  });

  it("secrets: {NAME} resolves through the secrets capability onto the wire — and the value is in neither content nor failed", async () => {
    const token = "s3cr3t-token-value";
    const out = await run(
      {
        url: `${base}/echo`,
        headers: { Accept: "text/x-plain" },
        secrets: { Authorization: "Bearer {API_TOKEN}", "X-Cookie": "a={A}; b={B}" },
        expect: { json: { auth: "nope" }, contains: [`${token}-extra`] },
      },
      { API_TOKEN: token, A: "aaaaaa", B: "bb" },
    );
    assert.deepEqual([lastHeaders.authorization, lastHeaders["x-cookie"], lastHeaders.accept], [`Bearer ${token}`, "a=aaaaaa; b=bb", "text/x-plain"], "resolved on the wire, plain headers beside");
    assert.equal(out.supports, false);
    assert.ok(!out.content.includes(token) && !out.content.includes("aaaaaa"), out.content);
    assert.match(out.content, /"auth":"Bearer \[MASKED_SECRET\]"/);
    assert.deepEqual(out.failed, ['body does not contain "[MASKED_SECRET]-extra"', 'json auth is "Bearer [MASKED_SECRET]", expected "nope"']);
    assert.match(out.content, /"cookie":"a=\[MASKED_SECRET\]; b=bb"/, "a value too short to mask safely stays");
  });

  it("a missing secret throws: a check with no credential cannot run", async () => {
    await assert.rejects(run({ url: `${base}/echo`, secrets: { Authorization: "Bearer {NOPE}" } }, { OTHER: "x" }), /http\/verify: secret "NOPE" is not in the secret store/);
  });

  it("a refused connection and a timeout THROW — cannot-run, nothing written", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await assert.rejects(run({ url: `http://127.0.0.1:${port}/ok` }), /^Error: http\/verify: GET http:\/\/127\.0\.0\.1:\d+\/ok could not be reached: /);

    await assert.rejects(run({ url: `${base}/hang`, timeoutMs: 50 }), /could not be reached/);
    const thrown = await run({ url: `${base}/hang`, timeoutMs: 50 }).then(
      () => assert.fail("resolved"),
      (e: Error) => mapCheckResult("http/verify", { status: "error", error: { message: e.message } }),
    );
    assert.equal(thrown.kind, "cannot-run");
  });

  it("evaluate / atPath are pure", () => {
    assert.deepEqual(evaluate({ status: 204, headers: {}, body: "" }, "", 1, {}), []);
    assert.deepEqual(evaluate({ status: 302, headers: { location: "/x" }, body: "" }, "", 1, { headers: { Location: "/x" } }), ["status 302, expected 2xx"]);
    assert.equal(atPath({ a: [{ b: 1 }] }, "a.0.b"), 1);
    assert.equal(atPath(null, "x"), undefined);
    assert.equal(atPath("str", "length"), undefined, "a primitive has no path into it");
  });
});
