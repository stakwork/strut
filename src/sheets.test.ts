import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import type { HttpResponse } from "./capabilities.js";
import { createRegistry } from "./steps/registry.js";
import createSpreadsheet from "./steps/lib/sheets/create-spreadsheet.js";
import updateValues from "./steps/lib/sheets/update-values.js";
import batchUpdateValues from "./steps/lib/sheets/batch-update-values.js";
import getValues from "./steps/lib/sheets/get-values.js";
import addSheet from "./steps/lib/sheets/add-sheet.js";
import importSpreadsheet from "./steps/lib/sheets/import-spreadsheet.js";

// ── Fake ctx ────────────────────────────────────────────────────────────────
//
// sheets/* steps go through ctx.services.http (raw REST). We stub it with a
// response map keyed by "METHOD url" (the Google host left on), and record
// every call. The service account carries a real RSA key so the JWT is signed
// and can be verified here.

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

// Access tokens are cached per client_email for the process, so each test
// gets its own account unless it means to share one.
let accounts = 0;
function serviceAccount() {
  accounts++;
  return {
    client_email: `agent${accounts}@proj.iam.gserviceaccount.com`,
    private_key: privateKey,
    token_uri: TOKEN_URI,
  };
}

interface Reply {
  status?: number;
  body: unknown;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth?: string;
}

function makeCtx(
  routes: Record<string, Reply | Reply[]>,
  opts: { secrets?: Record<string, string | undefined> } = {},
) {
  const calls: Call[] = [];
  const http = async (
    url: string,
    o: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<HttpResponse> => {
    const method = o.method ?? "GET";
    calls.push({ method, url, body: o.body, auth: o.headers?.Authorization });
    const key = `${method} ${url}`;
    const route =
      routes[key] ?? (url === TOKEN_URI ? { body: { access_token: "ya29.tok", expires_in: 3600 } } : undefined);
    const reply = Array.isArray(route) ? route.shift() : route;
    if (!reply) return { status: 404, ok: false, headers: {}, body: { error: { message: `no route ${key}` } } };
    const status = reply.status ?? 200;
    return { status, ok: status >= 200 && status < 300, headers: {}, body: reply.body };
  };
  const secrets = {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount()),
    ...opts.secrets,
  };
  const ctx = {
    runId: "t",
    path: "t",
    scope: {},
    input: {},
    emit: async () => {},
    services: { http, secrets: { get: async (n: string) => (secrets as Record<string, string | undefined>)[n] } },
  } as never;
  const api = () => calls.filter((c) => c.url !== TOKEN_URI);
  return { ctx, calls, api };
}

const run = (step: { run: Function }, cfg: Record<string, unknown>, ctx: never) =>
  step.run(cfg as never, ctx) as Promise<any>;

// ── Credentials ─────────────────────────────────────────────────────────────

describe("sheets credentials", () => {
  it("no service account → throws that sheets are unavailable, makes no request", async () => {
    const { ctx, calls } = makeCtx({}, { secrets: { GOOGLE_SERVICE_ACCOUNT_JSON: undefined } });
    await assert.rejects(run(getValues, { spreadsheet_id: "S", range: "A1" }, ctx), (err: Error) => {
      assert.match(err.message, /Google Sheets tools are UNAVAILABLE in this environment/);
      assert.match(err.message, /Proceed WITHOUT spreadsheets/);
      assert.doesNotMatch(err.message, /paste|GOOGLE_SERVICE_ACCOUNT_JSON/i);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  for (const [label, value] of [
    ["not JSON", "definitely-not-json-SECRETPART"],
    ["JSON without a private key", JSON.stringify({ client_email: "a@b", note: "SECRETPART" })],
    ["a private key that is not a key", JSON.stringify({ client_email: "a@b", private_key: "SECRETPART" })],
  ] as const) {
    it(`invalid service account (${label}) → throws unavailable, never quotes the secret`, async () => {
      const { ctx, calls } = makeCtx({}, { secrets: { GOOGLE_SERVICE_ACCOUNT_JSON: value } });
      await assert.rejects(run(addSheet, { spreadsheet_id: "S", title: "T" }, ctx), (err: Error) => {
        assert.match(err.message, /UNAVAILABLE in this environment \(the configured service account is not valid/);
        assert.doesNotMatch(err.message, /SECRETPART/);
        return true;
      });
      assert.equal(calls.length, 0);
    });
  }

  it("signs an RS256 assertion for the spreadsheets + drive scopes and sends the bearer token", async () => {
    const { ctx, calls } = makeCtx({ [`GET ${SHEETS}/S/values/A1?valueRenderOption=UNFORMATTED_VALUE`]: { body: { range: "Sheet1!A1", values: [[1]] } } });
    await run(getValues, { spreadsheet_id: "S", range: "A1" }, ctx);

    const token = calls[0]!;
    assert.equal(token.method, "POST");
    assert.equal(token.url, TOKEN_URI);
    const form = new URLSearchParams(token.body as string);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    const decode = (s: string) => JSON.parse(Buffer.from(s!, "base64url").toString("utf-8"));
    assert.deepEqual(decode(header!), { alg: "RS256", typ: "JWT" });
    const c = decode(claims!);
    assert.equal(c.scope, "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive");
    assert.equal(c.aud, TOKEN_URI);
    assert.match(c.iss, /@proj\.iam\.gserviceaccount\.com$/);
    assert.equal(c.exp - c.iat, 3600);
    const ok = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature!, "base64url");
    assert.ok(ok, "assertion signature verifies with the account's public key");

    assert.equal(calls[1]!.auth, "Bearer ya29.tok");
  });

  it("reuses the access token across steps for the same account", async () => {
    const { ctx, calls } = makeCtx({
      [`POST ${SHEETS}/S:batchUpdate`]: [
        { body: { replies: [{ addSheet: { properties: { sheetId: 1, title: "A" } } }] } },
        { body: { replies: [{ addSheet: { properties: { sheetId: 2, title: "B" } } }] } },
      ],
    });
    await run(addSheet, { spreadsheet_id: "S", title: "A" }, ctx);
    await run(addSheet, { spreadsheet_id: "S", title: "B" }, ctx);
    assert.equal(calls.filter((c) => c.url === TOKEN_URI).length, 1);
    assert.equal(calls.length, 3);
  });

  it("cfg.serviceAccount wins over the secret, as an object or base64 JSON", async () => {
    for (const form of ["object", "base64"] as const) {
      const sa = serviceAccount();
      const { ctx, calls } = makeCtx(
        { [`POST ${SHEETS}/S:batchUpdate`]: { body: { replies: [] } } },
        { secrets: { GOOGLE_SERVICE_ACCOUNT_JSON: undefined } },
      );
      const serviceAccountCfg = form === "object" ? sa : Buffer.from(JSON.stringify(sa)).toString("base64");
      const out = await run(addSheet, { spreadsheet_id: "S", title: "T", serviceAccount: serviceAccountCfg }, ctx);
      assert.deepEqual(out, { sheet_id: undefined, title: "T" });
      const claims = new URLSearchParams(calls[0]!.body as string).get("assertion")!.split(".")[1]!;
      assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).iss, sa.client_email);
    }
  });

  it("a rejected token exchange comes back as a string, not a throw", async () => {
    const { ctx } = makeCtx({ [`POST ${TOKEN_URI}`]: { status: 400, body: { error: "invalid_grant" } } });
    const out = await run(getValues, { spreadsheet_id: "S", range: "A1" }, ctx);
    assert.match(out, /^sheets_get_values failed: Google OAuth token exchange failed: HTTP 400: .*invalid_grant/);
  });
});

// ── Steps ───────────────────────────────────────────────────────────────────

describe("sheets/create-spreadsheet", () => {
  it("creates in the shared Drive folder from the secret, then adds the extra tabs", async () => {
    const { ctx, api } = makeCtx(
      {
        [`POST ${DRIVE}?supportsAllDrives=true`]: { body: { id: "NEW" } },
        [`POST ${SHEETS}/NEW:batchUpdate`]: { body: {} },
      },
      { secrets: { GOOGLE_DRIVE_FOLDER_ID: "FOLDER" } },
    );
    const out = await run(createSpreadsheet, { title: "Budget", extra_sheet_titles: ["Model", "Scenarios"] }, ctx);
    assert.deepEqual(out, {
      spreadsheet_id: "NEW",
      url: "https://docs.google.com/spreadsheets/d/NEW/edit",
      sheets: ["Sheet1", "Model", "Scenarios"],
    });
    assert.deepEqual(api()[0]!.body, {
      name: "Budget",
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: ["FOLDER"],
    });
    assert.deepEqual(api()[1]!.body, {
      requests: [{ addSheet: { properties: { title: "Model" } } }, { addSheet: { properties: { title: "Scenarios" } } }],
    });
  });

  it("cfg.driveFolderId wins over the secret", async () => {
    const { ctx, api } = makeCtx(
      { [`POST ${DRIVE}?supportsAllDrives=true`]: { body: { id: "NEW" } } },
      { secrets: { GOOGLE_DRIVE_FOLDER_ID: "FROM_SECRET" } },
    );
    await run(createSpreadsheet, { title: "T", driveFolderId: "FROM_CFG" }, ctx);
    assert.deepEqual((api()[0]!.body as any).parents, ["FROM_CFG"]);
  });

  it("without a folder, creates through the Sheets API", async () => {
    const { ctx, api } = makeCtx({ [`POST ${SHEETS}`]: { body: { spreadsheetId: "S1" } } });
    const out = await run(createSpreadsheet, { title: "T" }, ctx);
    assert.deepEqual(out, { spreadsheet_id: "S1", url: "https://docs.google.com/spreadsheets/d/S1/edit", sheets: ["Sheet1"] });
    assert.deepEqual(api()[0]!.body, { properties: { title: "T" } });
  });

  it("a Drive error is a string that says to share the folder with the client_email", async () => {
    const { ctx } = makeCtx(
      { [`POST ${DRIVE}?supportsAllDrives=true`]: { status: 404, body: { error: { message: "File not found: FOLDER." } } } },
      { secrets: { GOOGLE_DRIVE_FOLDER_ID: "FOLDER" } },
    );
    const out = await run(createSpreadsheet, { title: "T" }, ctx);
    assert.match(out, /^sheets_create_spreadsheet failed: HTTP 404: File not found: FOLDER\. \(if this is a permission error, share the Drive folder FOLDER with the service account's client_email agent\d+@/);
  });

  it("extra tabs that fail still return the spreadsheet, with a warning", async () => {
    const { ctx } = makeCtx({
      [`POST ${SHEETS}`]: { body: { spreadsheetId: "S1" } },
      [`POST ${SHEETS}/S1:batchUpdate`]: { status: 400, body: { error: { message: "duplicate title" } } },
    });
    const out = await run(createSpreadsheet, { title: "T", extra_sheet_titles: ["Sheet1"] }, ctx);
    assert.deepEqual(out, {
      spreadsheet_id: "S1",
      url: "https://docs.google.com/spreadsheets/d/S1/edit",
      warning: "adding extra sheets failed: HTTP 400: duplicate title",
    });
  });
});

describe("sheets/update-values", () => {
  it("PUTs the rows to the encoded range as USER_ENTERED (formulas live)", async () => {
    const url = `${SHEETS}/S/values/${encodeURIComponent("Model!A1:B2")}?valueInputOption=USER_ENTERED`;
    const { ctx, api } = makeCtx({ [`PUT ${url}`]: { body: { updatedRange: "Model!A1:B2", updatedCells: 4 } } });
    const values = [["a", 1], ["=SUM(B1)", null]];
    const out = await run(updateValues, { spreadsheet_id: "S", range: "Model!A1:B2", values }, ctx);
    assert.deepEqual(out, { updated_range: "Model!A1:B2", updated_cells: 4 });
    assert.deepEqual(api()[0]!.body, { values });
  });

  it("raw: true stores strings literally; an API error is a readable string", async () => {
    const url = `${SHEETS}/S/values/A1?valueInputOption=RAW`;
    const { ctx } = makeCtx({ [`PUT ${url}`]: { status: 400, body: { error: { message: "Unable to parse range: A1" } } } });
    const out = await run(updateValues, { spreadsheet_id: "S", range: "A1", values: [["x"]], raw: true }, ctx);
    assert.equal(out, "sheets_update_values failed: HTTP 400: Unable to parse range: A1");
  });
});

describe("sheets/batch-update-values", () => {
  it("writes every range in one call", async () => {
    const { ctx, api } = makeCtx({
      [`POST ${SHEETS}/S/values:batchUpdate`]: {
        body: { totalUpdatedCells: 3, responses: [{ updatedRange: "A1:B1" }, { updatedRange: "C3" }] },
      },
    });
    const data = [{ range: "A1:B1", values: [["h1", "h2"]] }, { range: "C3", values: [["=A1"]] }];
    const out = await run(batchUpdateValues, { spreadsheet_id: "S", data }, ctx);
    assert.deepEqual(out, { total_updated_cells: 3, updated_ranges: ["A1:B1", "C3"] });
    assert.deepEqual(api()[0]!.body, { valueInputOption: "USER_ENTERED", data });
  });
});

describe("sheets/get-values", () => {
  it("maps render to the value render option and defaults values to []", async () => {
    for (const [render, option] of [
      [undefined, "UNFORMATTED_VALUE"],
      ["formatted", "FORMATTED_VALUE"],
      ["formula", "FORMULA"],
    ] as const) {
      const { ctx } = makeCtx({ [`GET ${SHEETS}/S/values/A1?valueRenderOption=${option}`]: { body: { range: "Sheet1!A1" } } });
      const out = await run(getValues, { spreadsheet_id: "S", range: "A1", ...(render ? { render } : {}) }, ctx);
      assert.deepEqual(out, { range: "Sheet1!A1", values: [] });
    }
  });
});

describe("sheets/add-sheet", () => {
  it("returns the new tab's id and title", async () => {
    const { ctx, api } = makeCtx({
      [`POST ${SHEETS}/S:batchUpdate`]: { body: { replies: [{ addSheet: { properties: { sheetId: 42, title: "Scenarios" } } }] } },
    });
    const out = await run(addSheet, { spreadsheet_id: "S", title: "Scenarios" }, ctx);
    assert.deepEqual(out, { sheet_id: 42, title: "Scenarios" });
    assert.deepEqual(api()[0]!.body, { requests: [{ addSheet: { properties: { title: "Scenarios" } } }] });
  });
});

describe("sheets/import-spreadsheet", () => {
  it("converts an .xlsx, copies each sheet under a non-colliding name, warns, and deletes the copy", async () => {
    const rename = (sheetId: number, title: string) => ({
      requests: [{ updateSheetProperties: { properties: { sheetId, title }, fields: "title" } }],
    });
    const { ctx, api } = makeCtx({
      [`GET ${DRIVE}/XLSX?supportsAllDrives=true&fields=name,mimeType,parents`]: {
        body: { name: "budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", parents: ["P"] },
      },
      [`POST ${DRIVE}/XLSX/copy?supportsAllDrives=true`]: { body: { id: "TMP" } },
      [`GET ${SHEETS}/TMP?fields=properties.title,sheets.properties`]: {
        body: {
          properties: { title: "budget" },
          sheets: [{ properties: { sheetId: 10, title: "Q1" } }, { properties: { sheetId: 11, title: "Q2" } }],
        },
      },
      [`GET ${SHEETS}/DST?fields=sheets.properties.title`]: {
        body: { sheets: [{ properties: { title: "Sheet1" } }, { properties: { title: "SOURCE: budget.xlsx — Q1" } }] },
      },
      [`POST ${SHEETS}/TMP/sheets/10:copyTo`]: { body: { sheetId: 100 } },
      [`POST ${SHEETS}/TMP/sheets/11:copyTo`]: { body: { sheetId: 101 } },
      [`POST ${SHEETS}/DST:batchUpdate`]: [{ body: {} }, { status: 500, body: { error: { message: "backend" } } }],
      [`GET ${SHEETS}/DST/values/${encodeURIComponent("'SOURCE: budget.xlsx — Q1 (2)'")}?valueRenderOption=FORMULA`]: {
        body: { values: [["=Q2!A1", 3]] },
      },
      [`DELETE ${DRIVE}/TMP?supportsAllDrives=true`]: { body: "" },
    });

    const out = await run(importSpreadsheet, { destination_spreadsheet_id: "DST", source_file_id: "XLSX" }, ctx);

    assert.equal(out.destination_spreadsheet_id, "DST");
    assert.deepEqual(out.imported, [
      { source_sheet: "Q1", tab_name: "SOURCE: budget.xlsx — Q1 (2)", sheet_id: 100, status: "success" },
      {
        source_sheet: "Q2",
        tab_name: "Copy of Q2",
        sheet_id: 101,
        status: "copied_unrenamed",
        error: "rename failed: HTTP 500: backend",
      },
    ]);
    assert.equal(out.converted_copy_deleted, true);
    assert.equal(out.warnings.length, 2);
    assert.match(out.warnings[0], /Tab "SOURCE: budget\.xlsx — Q1 \(2\)" contains formula references to source sheet "Q2"/);
    assert.match(out.warnings[1], /Named ranges and protected ranges/);

    const calls = api();
    assert.deepEqual(calls.find((c) => c.url.endsWith("/copy?supportsAllDrives=true"))!.body, {
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: ["P"],
    });
    const renames = calls.filter((c) => c.url === `${SHEETS}/DST:batchUpdate`).map((c) => c.body);
    assert.deepEqual(renames, [rename(100, "SOURCE: budget.xlsx — Q1 (2)"), rename(101, "SOURCE: budget.xlsx — Q2")]);
    assert.equal(calls.at(-1)!.method, "DELETE");
  });

  it("a native single-sheet source is copied as 'SOURCE: <title>' with no conversion", async () => {
    const { ctx, api } = makeCtx({
      [`GET ${DRIVE}/NATIVE?supportsAllDrives=true&fields=name,mimeType,parents`]: {
        body: { name: "Drive name", mimeType: "application/vnd.google-apps.spreadsheet" },
      },
      [`GET ${SHEETS}/NATIVE?fields=properties.title,sheets.properties`]: {
        body: { properties: { title: "Rates" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] },
      },
      [`GET ${SHEETS}/DST?fields=sheets.properties.title`]: { body: { sheets: [] } },
      [`POST ${SHEETS}/NATIVE/sheets/0:copyTo`]: { body: { sheetId: 7 } },
      [`POST ${SHEETS}/DST:batchUpdate`]: { body: {} },
      [`GET ${SHEETS}/DST/values/${encodeURIComponent("'SOURCE: Rates'")}?valueRenderOption=FORMULA`]: { body: {} },
    });
    const out = await run(importSpreadsheet, { destination_spreadsheet_id: "DST", source_file_id: "NATIVE" }, ctx);
    assert.deepEqual(out.imported, [{ source_sheet: "Sheet1", tab_name: "SOURCE: Rates", sheet_id: 7, status: "success" }]);
    assert.equal(out.converted_copy_deleted, null);
    assert.ok(!api().some((c) => c.method === "DELETE" || c.url.includes("/copy?")));
  });

  it("an unreadable source is a readable string", async () => {
    const { ctx } = makeCtx({
      [`GET ${DRIVE}/GONE?supportsAllDrives=true&fields=name,mimeType,parents`]: { status: 404, body: { error: { message: "File not found: GONE." } } },
    });
    const out = await run(importSpreadsheet, { destination_spreadsheet_id: "DST", source_file_id: "GONE" }, ctx);
    assert.equal(out, "sheets_import_spreadsheet failed: could not fetch source file metadata: HTTP 404: File not found: GONE.");
  });
});

describe("sheets registry", () => {
  it("ships the six steps as lib steps", async () => {
    const registry = await createRegistry([]);
    for (const type of [
      "sheets/create-spreadsheet",
      "sheets/update-values",
      "sheets/batch-update-values",
      "sheets/get-values",
      "sheets/add-sheet",
      "sheets/import-spreadsheet",
    ]) {
      assert.ok(registry[type], `${type} is registered`);
    }
  });
});
