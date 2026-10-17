// Shared helpers for the sheets/* lib steps. Leading-underscore file → imported
// by siblings, skipped by registry discovery (see AGENTS.md). Like slack/* and
// x/*, these go through ctx.services.http (raw REST, no SDK), so a run is
// cassette-recordable and every secret read through ctx.services.secrets is
// scrubbed from the fixture.
//
// The contract (ported from the mcp lab's seeded sheets/* steps, which each
// inlined a copy of this preamble):
//   - Credentials: `cfg.serviceAccount` (a parsed JSON object, a JSON string,
//     or base64 JSON) wins, else the GOOGLE_SERVICE_ACCOUNT_JSON secret — the
//     same secret the gdrive/* steps read. `cfg.driveFolderId` wins, else the
//     GOOGLE_DRIVE_FOLDER_ID secret: spreadsheets are created inside that
//     folder (share it with the service account's client_email so people can
//     open what an agent made).
//   - Auth: the service-account JWT flow, an RS256 assertion signed with
//     node:crypto and exchanged at the account's token_uri for a bearer token
//     with the spreadsheets + drive scopes, cached per client_email.
//   - Errors: an API error comes back as a readable string for the calling
//     agent, never a throw. Only missing or invalid credentials throw, and
//     the text says sheets are unavailable here and to go on without them —
//     never a "paste the key into env" (seen live sending an agent hunting the
//     filesystem for service-account JSON).
import { createPrivateKey, createSign } from "node:crypto";
import { z } from "zod";
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const OAUTH_SCOPES =
  "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Refresh the cached access token this many seconds before it expires. */
const TOKEN_EXPIRY_SLACK_S = 60;

const UNAVAILABLE = "Google Sheets tools are UNAVAILABLE in this environment";
const PROCEED_WITHOUT =
  "This is not something you can fix: do NOT search the environment or filesystem for credentials, " +
  "and do NOT retry other sheets tools — they will all fail the same way. Proceed WITHOUT " +
  "spreadsheets: keep tabular and numeric work in local markdown files in your working directory.";

export const serviceAccountField = z
  .any()
  .optional()
  .describe(
    "Service-account credentials override (JSON object, JSON string, or base64 JSON). " +
      "Normally omitted — resolved from the GOOGLE_SERVICE_ACCOUNT_JSON secret.",
  );

export const driveFolderIdField = z
  .string()
  .optional()
  .describe(
    "Drive folder to create the spreadsheet in (must be shared with the service account's " +
      "client_email). Normally omitted — resolved from the GOOGLE_DRIVE_FOLDER_ID secret.",
  );

/** 2D array of cell values; strings starting with '=' become live formulas under USER_ENTERED. */
export const valuesSchema = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
  .describe(
    "2D array of rows. Strings starting with '=' are entered as live formulas (e.g. '=SUM(B2:B10)').",
  );

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Accept a service account as an object, a JSON string, or base64-encoded
 *  JSON. Throws the unavailable message on anything else — never the parser's
 *  own, which quotes the start of the input (the secret). */
export function parseServiceAccount(input: unknown): ServiceAccount {
  let obj: any = input;
  try {
    if (typeof input === "string") {
      const trimmed = input.trim();
      const json = trimmed.startsWith("{")
        ? trimmed
        : Buffer.from(trimmed, "base64").toString("utf-8");
      obj = JSON.parse(json);
    }
    if (
      !obj ||
      typeof obj !== "object" ||
      typeof obj.client_email !== "string" ||
      typeof obj.private_key !== "string"
    ) {
      throw new Error("not service-account JSON");
    }
    // Keys pasted through env/JSON sometimes carry literal "\n" sequences.
    const privateKey = obj.private_key.replace(/\\n/g, "\n");
    createPrivateKey(privateKey);
    return {
      client_email: obj.client_email,
      private_key: privateKey,
      token_uri: typeof obj.token_uri === "string" ? obj.token_uri : undefined,
    };
  } catch {
    throw new Error(
      `${UNAVAILABLE} (the configured service account is not valid service-account JSON ` +
        `with a client_email and a private key). ${PROCEED_WITHOUT}`,
    );
  }
}

export function truncate(value: unknown, maxChars: number): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}…[truncated, ${str.length} chars total]`;
}

export function errorResult(label: string, status: number, body: any): string {
  const message = body?.error?.message ?? body;
  return `${label} failed: HTTP ${status}: ${truncate(message, 500)}`;
}

/** Access tokens (Google's last ~1h), keyed by client_email so different
 *  credentials never mix. */
const tokens = new Map<string, { value: string; exp: number }>();

/** Resolve credentials (cfg wins → secret store → env) and return an
 *  authenticated Sheets/Drive request helper over ctx.services.http. */
export async function sheetsCtx(
  ctx: StepContext<StrutCapabilities> | undefined,
  cfg: { serviceAccount?: unknown; driveFolderId?: string },
) {
  const httpMaybe = ctx?.services?.http;
  if (!httpMaybe) {
    throw new Error("sheets: ctx.services.http unavailable — run with a services bag");
  }
  const http = httpMaybe;
  const secrets = ctx?.services?.secrets;
  const rawSa = cfg.serviceAccount ?? (await secrets?.get("GOOGLE_SERVICE_ACCOUNT_JSON"));
  if (!rawSa) {
    throw new Error(`${UNAVAILABLE} (no service account is configured). ${PROCEED_WITHOUT}`);
  }
  const sa = parseServiceAccount(rawSa);
  const driveFolderId =
    cfg.driveFolderId ?? (await secrets?.get("GOOGLE_DRIVE_FOLDER_ID")) ?? undefined;

  async function getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const cached = tokens.get(sa.client_email);
    if (cached && cached.exp - TOKEN_EXPIRY_SLACK_S > now) return cached.value;
    const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signingInput = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
      iss: sa.client_email,
      scope: OAUTH_SCOPES,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(sa.private_key)
      .toString("base64url");
    const res = await http(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${signature}`,
      }).toString(),
      timeout: 30_000,
    });
    const body = res.body as any;
    if (!res.ok || !body?.access_token) {
      throw new Error(
        `Google OAuth token exchange failed: HTTP ${res.status}: ${truncate(res.body, 300)}`,
      );
    }
    tokens.set(sa.client_email, {
      value: body.access_token,
      exp: now + (Number(body.expires_in) || 3600),
    });
    return body.access_token;
  }

  async function api(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ): Promise<{ ok: boolean; status: number; body: any }> {
    const token = await getToken();
    const res = await http(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { body: payload } : {}),
      timeout: 60_000,
    });
    return { ok: res.ok, status: res.status, body: res.body as any };
  }

  return { api, driveFolderId, clientEmail: sa.client_email };
}
