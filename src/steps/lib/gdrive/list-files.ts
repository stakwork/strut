import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { buildDriveClient, describeDriveError } from "./_shared.js";

const EXAMPLE = `- id: list
  type: gdrive/list-files
  config:
    folderId: "1AbCdEfGhIjKlMnOpQrStUvWxYz"
    modifiedAfter: "{{ input.since }}"   # RFC 3339, e.g. 2024-01-01T00:00:00Z`;

export default defineStep({
  type: "gdrive/list-files",
  description: `List Google Drive files — in a folder, modified after a timestamp, of a MIME type, or by raw query — for incremental indexing; pair with foreach → gdrive/export-file to process each. Auth as gdrive/export-file (OAuth accessToken, or the GOOGLE_ACCESS_TOKEN / GOOGLE_SERVICE_ACCOUNT_JSON secret, or ADC). Incremental sync: feed one run's newestModifiedTime into the next run's modifiedAfter; page with nextPageToken → pageToken.\n\n${EXAMPLE}`,
  input: z.object({
    folderId: z.string().optional().describe("only files whose parent is this folder ID"),
    modifiedAfter: z
      .string()
      .optional()
      .describe("RFC 3339 timestamp — only files modified strictly after it (the incremental-sync cursor: pass the previous run's newestModifiedTime)"),
    mimeType: z.string().optional().describe("exact MIME type filter, e.g. application/vnd.google-apps.document"),
    query: z
      .string()
      .optional()
      .describe("raw Drive `q` query — when set it REPLACES the folderId/modifiedAfter/mimeType/includeTrashed filters (see Drive \"search for files\")"),
    includeTrashed: z.boolean().default(false).describe("include trashed files; ignored when query is set"),
    pageSize: z.number().int().positive().max(1000).default(100).describe("files per page (Drive caps at 1000)"),
    pageToken: z.string().optional().describe("nextPageToken from the previous call, to fetch the next page"),
    orderBy: z.string().default("modifiedTime").describe("Drive orderBy, e.g. \"modifiedTime\", \"modifiedTime desc\", \"name\""),
    accessToken: z.string().optional().describe("OAuth access token; omit to use the GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON secret, else Application Default Credentials"),
  }),
  output: z.object({
    files: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        modifiedTime: z.string().nullable(),
        size: z.number().nullable(),
        webViewLink: z.string().nullable(),
      }),
    ),
    nextPageToken: z.string().nullable(),
    /** Max modifiedTime across the returned files — the cursor to feed the next
     *  run's `modifiedAfter`. Null when no files matched. */
    newestModifiedTime: z.string().nullable(),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { client, haveAuth } = await buildDriveClient(cfg.accessToken, ctx);
    const q = cfg.query ?? buildQuery(cfg);

    const { data } = await client.files
      .list({
        ...(q ? { q } : {}),
        pageSize: cfg.pageSize,
        ...(cfg.pageToken ? { pageToken: cfg.pageToken } : {}),
        orderBy: cfg.orderBy,
        fields:
          "nextPageToken, files(id,name,mimeType,modifiedTime,size,webViewLink)",
        // Surface files from shared drives too, not just My Drive.
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        spaces: "drive",
      })
      .catch((err: unknown) => {
        throw describeDriveError(err, "file listing", haveAuth);
      });

    const files = (data.files ?? []).map((f) => ({
      id: f.id ?? "",
      name: f.name ?? "unknown",
      mimeType: f.mimeType ?? "application/octet-stream",
      modifiedTime: f.modifiedTime ?? null,
      size: f.size != null ? Number(f.size) : null,
      webViewLink: f.webViewLink ?? null,
    }));

    const newestModifiedTime = files.reduce<string | null>((max, f) => {
      if (!f.modifiedTime) return max;
      return max === null || f.modifiedTime > max ? f.modifiedTime : max;
    }, null);

    return {
      files,
      nextPageToken: data.nextPageToken ?? null,
      newestModifiedTime,
    };
  },
});

/** Compose a Drive `q` from the convenience filters. Clauses are AND-ed; an
 *  empty result means "no filter" (list everything the creds can see).
 *  Exported for unit testing. */
export function buildQuery(cfg: {
  folderId?: string;
  modifiedAfter?: string;
  mimeType?: string;
  includeTrashed: boolean;
}): string {
  const clauses: string[] = [];
  if (cfg.folderId) clauses.push(`'${cfg.folderId}' in parents`);
  if (cfg.modifiedAfter) clauses.push(`modifiedTime > '${cfg.modifiedAfter}'`);
  if (cfg.mimeType) clauses.push(`mimeType = '${cfg.mimeType}'`);
  if (!cfg.includeTrashed) clauses.push("trashed = false");
  return clauses.join(" and ");
}
