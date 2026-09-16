import { z } from "zod";
import { defineStep } from "../../core.js";
import { httpCapability, type HttpCapability } from "../../capabilities.js";

const EXAMPLE = `- id: fetch
  type: http
  config:
    url: "https://api.example.com/data"
    method: GET
    headers:
      Authorization: "Bearer {{ input.token }}"`;

export default defineStep({
  type: "http",
  description:
    `Make an HTTP request. Output: { status, body } — body is parsed JSON when the response is JSON, else text. A non-2xx response throws (so retry/onError apply).\n\n` +
    `This step is also the REFERENCE for authoring an adapter: it performs the request through ctx.services.http(url, opts) — NOT the global fetch — so its calls are recordable/replayable by run_step's cassette and credentials can be injected by the services bag. Read this step's source (get_step("http", source: true)) to see the exact ctx.services.http usage.\n\n` +
    EXAMPLE,
  input: z.object({
    url: z.string().describe("absolute URL to request"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    body: z.any().optional().describe("request body: an object is sent as JSON, a string as-is"),
    headers: z.record(z.string(), z.string()).optional().describe("request headers, e.g. Authorization"),
    timeout: z.number().positive().optional().describe("abort after this many ms"),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    // Use the deployment's http capability so calls are recordable/replayable
    // (run_step cassettes) and credentials/transport are swappable. Fall back to
    // a global-fetch-backed capability when no services.http was injected (e.g. a
    // bare `runWorkflow(..., { services: {} })`).
    const http: HttpCapability =
      (ctx.services as { http?: HttpCapability } | undefined)?.http ??
      httpCapability();

    const res = await http(cfg.url, {
      method: cfg.method,
      ...(cfg.headers ? { headers: cfg.headers } : {}),
      ...(cfg.body !== undefined ? { body: cfg.body } : {}),
      ...(cfg.timeout ? { timeout: cfg.timeout } : {}),
    });

    if (!res.ok) {
      throw new Error(
        `HTTP ${cfg.method} ${cfg.url} returned ${res.status}: ${
          typeof res.body === "string" ? res.body : JSON.stringify(res.body)
        }`,
      );
    }

    return { status: res.status, body: res.body };
  },
});
