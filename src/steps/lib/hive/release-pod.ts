import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { hiveAuth } from "./_client.js";

const EXAMPLE = `- id: release
  type: hive/release-pod
  config:
    workspaceId: "{{ input.workspaceId }}"
    podId: "{{ pod.podId }}"
    taskId: "{{ input.taskId }}"`;

export default defineStep({
  type: "hive/release-pod",
  description:
    `Release (drop) a pod back to a Hive workspace's pool manager (POST /api/pool-manager/drop-pod/<workspaceId>?podId=…&taskId=…). ` +
    `Auth: the x-api-token header, from \`apiKey\` else the HIVE_API_KEY secret; the request target, from \`hiveUrl\` else the HIVE_URL secret. ` +
    `An org key can only release pods belonging to its own org. Output: { success, podId }.\n\n${EXAMPLE}`,
  input: z.object({
    workspaceId: z.string().min(1).describe("the Hive workspace the pod was claimed from"),
    podId: z.string().min(1).describe("the pod to release"),
    taskId: z.string().optional().describe("the task the pod was working on, if any"),
    hiveUrl: z.string().optional().describe("Hive swarm base URL; omit to use the HIVE_URL secret"),
    apiKey: z.string().optional().describe("org-scoped Hive API key; omit to use the HIVE_API_KEY secret"),
  }),
  output: z.object({
    success: z.boolean(),
    podId: z.string(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { baseUrl, apiKey } = await hiveAuth(cfg, ctx);
    const base = String(baseUrl).replace(/\/+$/, "");
    const query = new URLSearchParams();
    query.set("podId", cfg.podId);
    if (cfg.taskId) query.set("taskId", cfg.taskId);
    const url = `${base}/api/pool-manager/drop-pod/${encodeURIComponent(cfg.workspaceId)}?${query.toString()}`;

    const http = ctx.services.http;
    const res = await http(url, { method: "POST", headers: { "x-api-token": apiKey } });

    if (!res.ok) {
      const bodyStr = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      throw new Error(
        `Hive drop-pod failed for workspace "${cfg.workspaceId}", pod "${cfg.podId}": HTTP ${res.status} — ${bodyStr}. ` +
          `An org key can only release pods belonging to its own org — check the podId belongs to this org, and that HIVE_API_KEY is valid. ` +
          `(The credential itself is never included in this error.)`,
      );
    }

    const body = res.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
    return {
      success: (body.success as boolean | undefined) ?? true,
      podId: ((body.podId ?? body.pod_id) as string | undefined) ?? cfg.podId,
    };
  },
});
