import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { hiveAuth } from "./_client.js";

const EXAMPLE = `- id: pod
  type: hive/claim-pod
  config:
    workspaceId: "{{ input.workspaceId }}"`;

export default defineStep({
  type: "hive/claim-pod",
  description:
    `Claim a pod from a Hive workspace's pool manager (POST /api/pool-manager/claim-pod/<workspaceId>). ` +
    `Auth: the x-api-token header, from \`apiKey\` else the HIVE_API_KEY secret; the request target, from \`hiveUrl\` else the HIVE_URL secret. ` +
    `Output: { podId, podUrl, frontend, ide, control, password } — password is a credential and must never be logged.\n\n${EXAMPLE}`,
  input: z.object({
    workspaceId: z.string().min(1).describe("the Hive workspace to claim a pod from"),
    hiveUrl: z.string().optional().describe("Hive swarm base URL; omit to use the HIVE_URL secret"),
    apiKey: z.string().optional().describe("org-scoped Hive API key; omit to use the HIVE_API_KEY secret"),
  }),
  output: z.object({
    podId: z.string(),
    podUrl: z.string().nullable(),
    frontend: z.string().nullable(),
    ide: z.string().nullable(),
    control: z.string().nullable(),
    password: z.string().nullable().describe("sensitive credential — must not be logged"),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { baseUrl, apiKey } = await hiveAuth(cfg, ctx);
    const base = String(baseUrl).replace(/\/+$/, "");
    const url = `${base}/api/pool-manager/claim-pod/${encodeURIComponent(cfg.workspaceId)}`;

    const http = ctx.services.http;
    const res = await http(url, { method: "POST", headers: { "x-api-token": apiKey } });

    if (!res.ok) {
      const bodyStr = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      throw new Error(
        `Hive claim-pod failed for workspace "${cfg.workspaceId}": HTTP ${res.status} — ${bodyStr}. ` +
          `Check that the workspaceId is correct and that HIVE_API_KEY is a valid, non-expired org-scoped key with pool-manager access. ` +
          `(The credential itself is never included in this error.)`,
      );
    }

    const body = res.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
    const podId = (body.podId ?? body.pod_id) as string | undefined;
    if (!podId) {
      throw new Error(
        `Hive claim-pod for workspace "${cfg.workspaceId}" returned HTTP ${res.status} but the body had no podId or pod_id: ${JSON.stringify(body)}. ` +
          `The response shape may have changed.`,
      );
    }

    return {
      podId,
      podUrl: (body.pod_url as string | undefined) ?? null,
      frontend: (body.frontend as string | undefined) ?? null,
      ide: (body.ide as string | undefined) ?? null,
      control: (body.control as string | undefined) ?? null,
      password: (body.password as string | undefined) ?? null,
    };
  },
});
