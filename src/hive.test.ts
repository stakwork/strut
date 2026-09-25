import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "./capabilities.js";
import claimPod from "./steps/lib/hive/claim-pod.js";
import releasePod from "./steps/lib/hive/release-pod.js";

// ── Fake ctx ────────────────────────────────────────────────────────────────
//
// hive/* steps go through ctx.services.http (raw REST). We stub it with a
// single canned reply and record every call's url/method/headers.

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

function makeCtx(
  reply: { status?: number; body?: unknown } = { status: 200, body: {} },
  opts: { secrets?: Record<string, string> } = {},
) {
  const calls: Call[] = [];
  const http = async (
    url: string,
    o: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<HttpResponse> => {
    calls.push({ url, method: o.method, headers: o.headers });
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {},
      body: reply.body,
    };
  };
  const ctx = {
    runId: "t",
    path: "t",
    scope: {},
    input: {},
    emit: async () => {},
    services: {
      http,
      secrets: { get: async (n: string) => opts.secrets?.[n] },
    },
  } as never;
  return { ctx, calls };
}

// ── claim-pod ────────────────────────────────────────────────────────────────

describe("hive/claim-pod", () => {
  it("builds the URL, POSTs, and sends the x-api-token header", async () => {
    const { ctx, calls } = makeCtx({
      status: 200,
      body: { podId: "ef3ae5d7", pod_url: "https://pod.example", frontend: "https://fe.example", control: "https://ctl.example", password: "s3cret" },
    });
    const out = await claimPod.run(
      { workspaceId: "ws one", hiveUrl: "https://hive.example", apiKey: "org-key" },
      ctx,
    );

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      `https://hive.example/api/pool-manager/claim-pod/${encodeURIComponent("ws one")}`,
    );
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers?.["x-api-token"], "org-key");

    assert.deepEqual(out, {
      podId: "ef3ae5d7",
      podUrl: "https://pod.example",
      frontend: "https://fe.example",
      ide: null,
      control: "https://ctl.example",
      password: "s3cret",
    });
  });

  it("falls back to HIVE_URL / HIVE_API_KEY secrets when config is omitted", async () => {
    const { ctx, calls } = makeCtx(
      { status: 200, body: { podId: "abc" } },
      { secrets: { HIVE_URL: "https://from-secret.example", HIVE_API_KEY: "secret-key" } },
    );
    await claimPod.run({ workspaceId: "ws1" }, ctx);

    assert.equal(calls[0]!.url, "https://from-secret.example/api/pool-manager/claim-pod/ws1");
    assert.equal(calls[0]!.headers?.["x-api-token"], "secret-key");
  });

  it("explicit config wins over the secret fallback", async () => {
    const { ctx, calls } = makeCtx(
      { status: 200, body: { podId: "abc" } },
      { secrets: { HIVE_URL: "https://from-secret.example", HIVE_API_KEY: "secret-key" } },
    );
    await claimPod.run({ workspaceId: "ws1", hiveUrl: "https://config.example", apiKey: "config-key" }, ctx);

    assert.equal(calls[0]!.url, "https://config.example/api/pool-manager/claim-pod/ws1");
    assert.equal(calls[0]!.headers?.["x-api-token"], "config-key");
  });

  it("strips trailing slashes from HIVE_URL", async () => {
    const { ctx, calls } = makeCtx({ status: 200, body: { podId: "abc" } });
    await claimPod.run({ workspaceId: "ws1", hiveUrl: "https://hive.example///", apiKey: "k" }, ctx);

    assert.equal(calls[0]!.url, "https://hive.example/api/pool-manager/claim-pod/ws1");
  });

  it("errors clearly when HIVE_URL is missing", async () => {
    const { ctx } = makeCtx({}, { secrets: { HIVE_API_KEY: "k" } });
    await assert.rejects(
      () => claimPod.run({ workspaceId: "ws1" }, ctx),
      /HIVE_URL secret is not set.*Secrets dialog.*hiveUrl/s,
    );
  });

  it("errors clearly when HIVE_API_KEY is missing", async () => {
    const { ctx } = makeCtx({}, { secrets: { HIVE_URL: "https://hive.example" } });
    await assert.rejects(
      () => claimPod.run({ workspaceId: "ws1" }, ctx),
      /HIVE_API_KEY secret is not set.*Secrets dialog.*apiKey/s,
    );
  });

  it("a non-2xx error carries status and body but never the key", async () => {
    const { ctx } = makeCtx({ status: 403, body: { error: "forbidden" } });
    await assert.rejects(
      () => claimPod.run({ workspaceId: "ws1", hiveUrl: "https://hive.example", apiKey: "super-secret-key" }, ctx),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /HTTP 403/);
        assert.match(msg, /forbidden/);
        assert.doesNotMatch(msg, /super-secret-key/);
        return true;
      },
    );
  });

  it("falls back to pod_id when podId is absent", async () => {
    const { ctx } = makeCtx({ status: 200, body: { pod_id: "legacy-id" } });
    const out = await claimPod.run({ workspaceId: "ws1", hiveUrl: "https://hive.example", apiKey: "k" }, ctx);
    assert.equal(out.podId, "legacy-id");
  });

  it("throws when a 2xx response has no podId or pod_id", async () => {
    const { ctx } = makeCtx({ status: 200, body: { foo: "bar" } });
    await assert.rejects(
      () => claimPod.run({ workspaceId: "ws1", hiveUrl: "https://hive.example", apiKey: "k" }, ctx),
      /no podId or pod_id/,
    );
  });
});

// ── release-pod ──────────────────────────────────────────────────────────────

describe("hive/release-pod", () => {
  it("builds the URL with podId and taskId in the query, POSTs, and sends the header", async () => {
    const { ctx, calls } = makeCtx({ status: 200, body: { success: true, podId: "pod1" } });
    const out = await releasePod.run(
      { workspaceId: "ws one", podId: "pod one", taskId: "task one", hiveUrl: "https://hive.example", apiKey: "org-key" },
      ctx,
    );

    const expectedQuery = new URLSearchParams();
    expectedQuery.set("podId", "pod one");
    expectedQuery.set("taskId", "task one");
    assert.equal(
      calls[0]!.url,
      `https://hive.example/api/pool-manager/drop-pod/${encodeURIComponent("ws one")}?${expectedQuery.toString()}`,
    );
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers?.["x-api-token"], "org-key");
    assert.deepEqual(out, { success: true, podId: "pod1" });
  });

  it("omits taskId from the query when not given", async () => {
    const { ctx, calls } = makeCtx({ status: 200, body: { success: true, podId: "pod1" } });
    await releasePod.run({ workspaceId: "ws1", podId: "pod1", hiveUrl: "https://hive.example", apiKey: "k" }, ctx);

    assert.equal(calls[0]!.url, "https://hive.example/api/pool-manager/drop-pod/ws1?podId=pod1");
  });

  it("falls back to HIVE_URL / HIVE_API_KEY secrets and strips trailing slash", async () => {
    const { ctx, calls } = makeCtx(
      { status: 200, body: { success: true } },
      { secrets: { HIVE_URL: "https://from-secret.example/", HIVE_API_KEY: "secret-key" } },
    );
    await releasePod.run({ workspaceId: "ws1", podId: "pod1" }, ctx);

    assert.equal(calls[0]!.url, "https://from-secret.example/api/pool-manager/drop-pod/ws1?podId=pod1");
    assert.equal(calls[0]!.headers?.["x-api-token"], "secret-key");
  });

  it("errors clearly when HIVE_URL is missing", async () => {
    const { ctx } = makeCtx({}, { secrets: { HIVE_API_KEY: "k" } });
    await assert.rejects(
      () => releasePod.run({ workspaceId: "ws1", podId: "pod1" }, ctx),
      /HIVE_URL secret is not set.*Secrets dialog.*hiveUrl/s,
    );
  });

  it("errors clearly when HIVE_API_KEY is missing", async () => {
    const { ctx } = makeCtx({}, { secrets: { HIVE_URL: "https://hive.example" } });
    await assert.rejects(
      () => releasePod.run({ workspaceId: "ws1", podId: "pod1" }, ctx),
      /HIVE_API_KEY secret is not set.*Secrets dialog.*apiKey/s,
    );
  });

  it("a non-2xx error carries status and body but never the key", async () => {
    const { ctx } = makeCtx({ status: 409, body: { error: "not your org" } });
    await assert.rejects(
      () => releasePod.run({ workspaceId: "ws1", podId: "pod1", hiveUrl: "https://hive.example", apiKey: "super-secret-key" }, ctx),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /HTTP 409/);
        assert.match(msg, /not your org/);
        assert.doesNotMatch(msg, /super-secret-key/);
        return true;
      },
    );
  });

  it("success defaults to true and podId falls back to cfg.podId", async () => {
    const { ctx } = makeCtx({ status: 200, body: {} });
    const out = await releasePod.run({ workspaceId: "ws1", podId: "pod1", hiveUrl: "https://hive.example", apiKey: "k" }, ctx);
    assert.deepEqual(out, { success: true, podId: "pod1" });
  });
});
