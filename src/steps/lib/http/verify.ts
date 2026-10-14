import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { HttpCapability, HttpResponse, StrutCapabilities } from "../../../capabilities.js";
import { maskSecretValues } from "../../../shell.js";

/**
 * The endpoint instrument (plans/job-claims.md §4): one request, the check
 * contract back — `{ supports, content, locator }` plus what was measured,
 * so a check on a job (or a workflow) is one line of config and
 * `mapCheckResult` (verify.ts) needs nothing new.
 *
 * The rule that makes it a check and not a request: the ENDPOINT failing is
 * a result, the INSTRUMENT failing is cannot-run. A status that is not the
 * expected one — a 500 included — a header, a substring, a JSON value or a
 * time budget that does not hold, is `supports: false` with `failed` naming
 * each. A connection refused, a DNS failure or a timeout throws, which the
 * pass maps to cannot-run: nothing is written and the claim stays unknown.
 *
 * Credentials are NAMED, never written: a check's config is a graph
 * property, so `secrets` maps a header to a value TEMPLATE whose `{NAME}`
 * placeholders (single braces — the runner's `{{ }}` engine never sees
 * them) are filled from `ctx.services.secrets` here, in code, and go two
 * places only: the request, and the mask list applied to everything this
 * step returns or throws. The secrets capability is bound to the run's
 * principal, so the launching person's token is what resolves.
 *
 * Over `ctx.services.http`: cassette-recordable, and the same transport
 * every adapter uses.
 */

const EXAMPLE = `- id: settings_api
  type: http/verify
  config:
    url: "{{ input.urls.pod }}/api/settings"
    headers: { Accept: application/json }
    secrets: { Authorization: "Bearer {API_TOKEN}" }
    expect:
      status: 200
      headers: { content-type: application/json }
      contains: ["notifications"]
      json: { "settings.notifications.email": true }
      maxMs: 2000`;

/** How much of the body `content` carries. */
export const BODY_EXCERPT_CHARS = 300;
/** Each `failed` line is bounded too: an expected value can be long. */
const FAILED_LINE_CHARS = 200;
/** Very short secret values would mask common substrings everywhere. */
const MASK_MIN_CHARS = 6;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** What the answer must satisfy. Absent, a 2xx supports. */
const EXPECT = z.object({
  status: z.union([z.number().int(), z.array(z.number().int())]).optional().describe("the status, or any of several (default: any 2xx)"),
  headers: z.record(z.string(), z.string()).optional().describe("response header → a substring its value must contain (header names case-insensitive)"),
  contains: z.array(z.string()).optional().describe("substrings the body must contain"),
  json: z.record(z.string(), z.unknown()).optional().describe('dot path into the JSON body → the value it must deep-equal, e.g. { "settings.notifications.email": true }'),
  maxMs: z.number().positive().optional().describe("the answer must arrive within this many ms"),
});
export type Expect = z.infer<typeof EXPECT>;

export default defineStep({
  type: "http/verify",
  description:
    `Call an endpoint and report whether it answered as expected — the check contract { supports, content, locator: { url } } plus status, ms and failed (one line per expectation that did not hold). ` +
    `With no \`expect\`, a 2xx supports. \`expect\` may name a status (or several), response headers (substring, names case-insensitive), substrings the body must contain, JSON values by dot path (deep-equal), and a time budget in ms. ` +
    `A wrong status (500 included) or a failed expectation is a RESULT (supports: false); a refused connection, a DNS failure or a timeout THROWS, so the verify pass records nothing. ` +
    `Credentials are named, never written: \`secrets\` maps a header to a value template whose {NAME} placeholders (single braces) resolve through the secret store; a missing one throws, and the values are masked out of content and failed.\n\n` +
    EXAMPLE,
  input: z.object({
    url: z.string().describe("absolute URL to request"),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional().describe("plain request headers (Accept, …) — never a credential"),
    body: z.any().optional().describe("request body: an object is sent as JSON, a string as-is"),
    secrets: z
      .record(z.string(), z.string())
      .optional()
      .describe('header name → a value template; each {NAME} is replaced by the secret NAME from the secret store, e.g. { Authorization: "Bearer {API_TOKEN}" }. A missing secret throws (the check cannot run)'),
    expect: EXPECT.optional(),
    timeoutMs: z.number().int().positive().default(30_000).describe("abort after this many ms — a timeout throws (cannot-run), it is not a failed expectation"),
  }),
  output: z.object({
    supports: z.boolean(),
    content: z.string(),
    locator: z.object({ url: z.string() }),
    status: z.number(),
    ms: z.number(),
    failed: z.array(z.string()),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const http: HttpCapability | undefined = ctx?.services?.http;
    if (!http) throw new Error("http/verify requires the http capability (ctx.services.http)");

    // Secrets: resolved here, in code, into the request headers and the mask
    // list — never the config, the events, or the output.
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    const secretValues: string[] = [];
    if (cfg.secrets) {
      const secrets = ctx.services?.secrets;
      if (!secrets) throw new Error("http/verify: `secrets` requires the secrets capability (ctx.services.secrets)");
      for (const [header, template] of Object.entries(cfg.secrets)) {
        const names = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
        const values: Record<string, string> = {};
        for (const name of names) {
          const v = await secrets.get(name);
          if (v === undefined) throw new Error(`http/verify: secret "${name}" is not in the secret store — add it under Secrets or drop it from \`secrets\``);
          values[name] = v;
          if (v.length >= MASK_MIN_CHARS) secretValues.push(v);
        }
        headers[header] = template.replace(PLACEHOLDER, (_, name: string) => values[name]!);
      }
    }
    const mask = (s: string) => maskSecretValues(s, secretValues);

    const started = Date.now();
    let res: HttpResponse;
    try {
      res = await http(cfg.url, {
        method: cfg.method,
        headers,
        ...(cfg.body !== undefined ? { body: cfg.body } : {}),
        timeout: cfg.timeoutMs,
      });
    } catch (err) {
      // The instrument failed, not the endpoint: cannot-run.
      const message = err instanceof Error ? err.message : String(err);
      const cause = (err as { cause?: { message?: string; code?: string } })?.cause;
      const detail = cause?.code ?? cause?.message;
      throw new Error(mask(`http/verify: ${cfg.method} ${cfg.url} could not be reached: ${message}${detail ? ` (${detail})` : ""}`));
    }
    const ms = Date.now() - started;

    const bodyText = typeof res.body === "string" ? res.body : res.body === undefined ? "" : JSON.stringify(res.body);
    const failed = evaluate(res, bodyText, ms, cfg.expect ?? {}).map((f) => mask(bound(f, FAILED_LINE_CHARS)));
    const expectations = countExpectations(cfg.expect ?? {});
    const verdict = failed.length ? `${failed.length} of ${expectations} expectation${expectations === 1 ? "" : "s"} failed: ${failed.join("; ")}` : "ok";
    const excerpt = bodyText.trim() ? `; body: ${bound(bodyText.replace(/\s+/g, " ").trim(), BODY_EXCERPT_CHARS)}` : "";
    return {
      supports: failed.length === 0,
      content: mask(`${cfg.method} ${cfg.url} → ${res.status} in ${ms} ms, ${verdict}${excerpt}`),
      locator: { url: cfg.url },
      status: res.status,
      ms,
      failed,
    };
  },
});

/** The expectations that did not hold, one line each. Pure. */
export function evaluate(res: Pick<HttpResponse, "status" | "headers" | "body">, bodyText: string, ms: number, expect: Expect): string[] {
  const failed: string[] = [];

  if (expect.status === undefined) {
    if (res.status < 200 || res.status >= 300) failed.push(`status ${res.status}, expected 2xx`);
  } else {
    const wanted = Array.isArray(expect.status) ? expect.status : [expect.status];
    if (!wanted.includes(res.status)) failed.push(`status ${res.status}, expected ${wanted.join(" or ")}`);
  }

  for (const [name, sub] of Object.entries(expect.headers ?? {})) {
    const key = name.toLowerCase();
    const actual = Object.entries(res.headers).find(([k]) => k.toLowerCase() === key)?.[1];
    if (actual === undefined) failed.push(`header ${key} missing, expected to contain ${JSON.stringify(sub)}`);
    else if (!actual.includes(sub)) failed.push(`header ${key} ${JSON.stringify(actual)} does not contain ${JSON.stringify(sub)}`);
  }

  for (const sub of expect.contains ?? []) {
    if (!bodyText.includes(sub)) failed.push(`body does not contain ${JSON.stringify(sub)}`);
  }

  const paths = Object.entries(expect.json ?? {});
  if (paths.length) {
    const parsed = parseJsonBody(res.body);
    if (parsed === NOT_JSON) failed.push(`body is not JSON (${paths.map(([p]) => p).join(", ")})`);
    else {
      for (const [path, want] of paths) {
        const got = atPath(parsed, path);
        if (!deepEqual(got, want)) failed.push(`json ${path} is ${got === undefined ? "missing" : JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      }
    }
  }

  if (expect.maxMs !== undefined && ms > expect.maxMs) failed.push(`took ${ms} ms, expected at most ${expect.maxMs} ms`);
  return failed;
}

function countExpectations(expect: Expect): number {
  return (
    1 + // the status: always expected, 2xx by default
    Object.keys(expect.headers ?? {}).length +
    (expect.contains?.length ?? 0) +
    Object.keys(expect.json ?? {}).length +
    (expect.maxMs !== undefined ? 1 : 0)
  );
}

const NOT_JSON = Symbol("not json");

/** The http capability parses a JSON body already; a text one that is JSON
 *  without the content type is parsed here. */
function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return NOT_JSON;
  }
}

/** `a.b.0.c` into a parsed value; `undefined` when the path is not there. */
export function atPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Equality on JSON values: key order does not matter, types do. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const bound = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
