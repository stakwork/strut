/**
 * The MCP registry — the servers this strut knows, kept across launches
 * (stakwork/peel docs/connectors-and-authoring.md §1): `PUT /mcp-servers/:name
 * { url, tokenSecret?, headerSecrets?, toolFilter?, ungated? }`. Where a
 * launch's `mcp` (src/mcp-servers.ts) hands strut a server for one run, a
 * registration names one once, and an agent is granted its tools by name:
 * `agentTools: ["mcp/linear/*"]` (or `mcp/*`, every server; or one tool,
 * `mcp/linear/list_issues`). A per-launch server is untouched by any of it.
 *
 * Values by secret NAME, never a value: `tokenSecret` (the Authorization
 * bearer) and `headerSecrets` (header → secret name) resolve through the
 * run's `secrets` capability when an agent step connects, so a person's own
 * key (an actor secret) wins over the deployment's — one registration
 * serves each person with their own token. The record holds nothing secret;
 * it is a plain JSON file under the data dir.
 *
 * Gating: every tool of a registered server asks the person first (a
 * proposal, src/proposals.ts) unless the server marks it `readOnlyHint`
 * or the registration lists it in `ungated` (tool names, globs); an agent's
 * `approve:` naming `mcp/<server>/<tool>` gates it whatever the hint. An
 * accepted proposal runs the tool once, in code, with the proposing run's
 * principal's secrets (`mcpStepDef`).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AnyStepDef, McpServer } from "./core.js";
import type { SecretsCapability } from "./capabilities.js";
import { globToRegExp } from "./closure.js";
import { isValidSecretName } from "./secret-store.js";
import { callMcpTool, type McpToolInfo } from "./mcp-servers.js";

export interface McpRegistration {
  name: string;
  url: string;
  /** The secret whose value is sent as `Authorization: Bearer <value>`. */
  tokenSecret?: string;
  /** Header name → the secret whose value it carries. */
  headerSecrets?: Record<string, string>;
  /** Only these of its tools (names or globs); absent = all. */
  toolFilter?: string[];
  /** Tools that run without asking although the server does not mark them
   *  read-only (names or globs): the person's "Always allow". */
  ungated?: string[];
}

/** `ctx.services.mcpRegistry`, which `createStrut` sets. */
export interface McpRegistry {
  list(): Promise<McpRegistration[]>;
  get(name: string): Promise<McpRegistration | undefined>;
  put(reg: McpRegistration): Promise<void>;
  remove(name: string): Promise<boolean>;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((t) => typeof t === "string");

/** A PUT body, validated, under the path's name. Throws for the 400. */
export function parseRegistration(name: string, body: unknown, opts: { allowLocal?: boolean } = {}): McpRegistration {
  if (!NAME_RE.test(name)) throw new Error(`name must be 1-32 letters, digits, "_" or "-" (it prefixes the server's tools)`);
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b["url"] !== "string") throw new Error("url (string) is required");
  let url: URL;
  try {
    url = new URL(b["url"]);
  } catch {
    throw new Error("url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must be http(s)");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("url must not carry credentials or a query: name a secret in tokenSecret or headerSecrets");
  }
  if (isLocalHost(url.hostname) && !opts.allowLocal) {
    throw new Error("url is on this machine or its link-local network: set STRUT_MCP_LOCAL=1 to register a local server");
  }
  // strut's own keys never ride to a server (STRUT_API_KEY would be its door).
  const secretName = (v: unknown) => typeof v === "string" && isValidSecretName(v) && !v.startsWith("STRUT_");
  const token = b["tokenSecret"];
  if (token !== undefined && !secretName(token)) throw new Error("tokenSecret must be a secret NAME, not one of strut's own (STRUT_*)");
  const headers = b["headerSecrets"];
  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("headerSecrets must map header names to secret NAMES");
    for (const [h, s] of Object.entries(headers)) {
      if (!/^[A-Za-z0-9-]+$/.test(h) || !secretName(s)) throw new Error(`headerSecrets.${h} must be a secret NAME, not one of strut's own (STRUT_*)`);
    }
  }
  for (const key of ["toolFilter", "ungated"] as const) {
    if (b[key] !== undefined && !isStrings(b[key])) throw new Error(`${key} must be an array of tool names`);
  }
  for (const key of Object.keys(b)) {
    if (!["url", "tokenSecret", "headerSecrets", "toolFilter", "ungated"].includes(key)) throw new Error(`unknown field "${key}" (values go in secrets, named by tokenSecret / headerSecrets)`);
  }
  return {
    name,
    url: b["url"],
    ...(token ? { tokenSecret: token as string } : {}),
    ...(headers && Object.keys(headers).length ? { headerSecrets: headers as Record<string, string> } : {}),
    ...((b["toolFilter"] as string[] | undefined)?.length ? { toolFilter: b["toolFilter"] as string[] } : {}),
    ...((b["ungated"] as string[] | undefined)?.length ? { ungated: b["ungated"] as string[] } : {}),
  };
}

/** Loopback, unspecified and link-local hosts (169.254/16: a cloud's
 *  metadata service), by name or literal: off unless STRUT_MCP_LOCAL=1. */
function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::" || h === "::1" ||
    /^127\./.test(h) || /^169\.254\./.test(h) || /^fe80:/.test(h) || /^::ffff:(127|169\.254)\./.test(h)
  );
}

/** The registry as one JSON file, `<dataDir>/mcp-servers.json`. */
export function fileMcpRegistry(dataDir: string): McpRegistry {
  const file = join(dataDir, "mcp-servers.json");
  let chain: Promise<unknown> = Promise.resolve();
  // Null-prototype: a name like "constructor" is never found on Object's.
  const read = async (): Promise<Record<string, McpRegistration>> => {
    try {
      return Object.assign(Object.create(null), JSON.parse(await readFile(file, "utf-8"))) as Record<string, McpRegistration>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
      throw err;
    }
  };
  const write = async (all: Record<string, McpRegistration>) => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  // One writer at a time: a read-modify-write per change.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    list: async () => Object.values(await read()).sort((a, b) => a.name.localeCompare(b.name)),
    get: async (name) => (await read())[name],
    put: (reg) =>
      serial(async () => {
        const all = await read();
        all[reg.name] = reg;
        await write(all);
      }),
    remove: (name) =>
      serial(async () => {
        const all = await read();
        if (!all[name]) return false;
        delete all[name];
        await write(all);
        return true;
      }),
  };
}

/** A registration as a server to connect to, its secrets read through
 *  `secrets` (the run's, bound to its principal: the actor's own first).
 *  Throws naming a secret that is not set. */
export async function resolveRegistration(reg: McpRegistration, secrets: SecretsCapability | undefined): Promise<McpServer> {
  const value = async (name: string) => {
    const v = await secrets?.get(name);
    if (!v) throw new Error(`MCP server "${reg.name}": the secret ${name} is not set`);
    return v;
  };
  const headers: Record<string, string> = {};
  for (const [h, s] of Object.entries(reg.headerSecrets ?? {})) headers[h] = await value(s);
  return {
    name: reg.name,
    url: reg.url,
    ...(reg.tokenSecret ? { token: await value(reg.tokenSecret) } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(reg.toolFilter ? { toolFilter: reg.toolFilter } : {}),
  };
}

export const MCP_GRANT_PREFIX = "mcp/";

/** `mcp/<server>/<tool>` for one tool of a registered server. */
export const mcpGrantName = (server: string, tool: string) => `${MCP_GRANT_PREFIX}${server}/${tool}`;

/** Does a list of `mcp/…` entries (globs) name this tool? */
export function grantsTool(entries: readonly string[], server: string, tool: string): boolean {
  const name = mcpGrantName(server, tool);
  return entries.some((e) => globToRegExp(e).test(name));
}

/** Is a registered server's tool gated by default: not marked read-only by
 *  the server, and not ungated by the registration. */
export function gatedByDefault(reg: McpRegistration, tool: McpToolInfo): boolean {
  if (tool.annotations?.readOnlyHint === true) return false;
  return !(reg.ungated ?? []).some((p) => globToRegExp(p).test(tool.name));
}

/**
 * `mcp/<server>/<tool>` as a step def, for what runs a registered tool
 * outside an agent: an accepted proposal (`decideProposal`'s `stepFor`).
 * Undefined when the type is not one, or the server is not registered.
 */
export async function mcpStepDef(type: string, registry: McpRegistry): Promise<AnyStepDef | undefined> {
  if (!type.startsWith(MCP_GRANT_PREFIX)) return undefined;
  const rest = type.slice(MCP_GRANT_PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut <= 0 || cut === rest.length - 1) return undefined;
  const server = rest.slice(0, cut);
  const tool = rest.slice(cut + 1);
  const reg = await registry.get(server);
  if (!reg) return undefined;
  return {
    type,
    description: `Call the "${tool}" tool of the MCP server ${server} (${new URL(reg.url).origin}).`,
    input: z.record(z.string(), z.unknown()),
    output: z.any(),
    async run(input: Record<string, unknown>, ctx) {
      const secrets = (ctx.services as { secrets?: SecretsCapability } | undefined)?.secrets;
      return callMcpTool(await resolveRegistration(reg, secrets), tool, input);
    },
  };
}
