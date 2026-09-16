import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { buildDriveClient, statusOf, describeDriveError } from "./_shared.js";

const EXAMPLE = `- id: doc
  type: gdrive/export-file
  config:
    fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz"
    accessToken: "{{ input.googleAccessToken }}"`;

// Default export format per Google-native ("application/vnd.google-apps.*")
// type. Anything not listed here falls back to text/plain; non-Google files
// are downloaded as-is via alt=media. Override with `exportMimeType`.
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps";
const DEFAULT_NATIVE_EXPORT = "text/plain";

export default defineStep({
  type: "gdrive/export-file",
  description: `Fetch a Google Drive file as text for LLM consumption: Google-native files are exported (Docs → markdown, Sheets → CSV, Slides → text), anything else is downloaded as-is. Auth: an OAuth accessToken, else the GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON secret, else Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS). Pair with gdrive/list-files + foreach to process a folder.\n\n${EXAMPLE}`,
  input: z.object({
    fileId: z.string().min(1).describe("Drive file ID (from the file's URL or gdrive/list-files)"),
    accessToken: z.string().optional().describe("OAuth access token; omit to use the GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON secret, else Application Default Credentials"),
    exportMimeType: z
      .string()
      .optional()
      .describe("override the export MIME type for Google-native files; ignored for other files (always downloaded as-is)"),
    maxChars: z.number().int().positive().default(50000).describe("truncate content to this many characters (sets truncated: true)"),
  }),
  output: z.object({
    content: z.string(),
    truncated: z.boolean(),
    file: z.object({
      id: z.string(),
      name: z.string(),
      mimeType: z.string(),
      modifiedTime: z.string().nullable(),
      size: z.number().nullable(),
      webViewLink: z.string().nullable(),
    }),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const { client, haveAuth } = await buildDriveClient(cfg.accessToken, ctx);
    const resource = `file "${cfg.fileId}"`;

    const { data: meta } = await client.files
      .get({
        fileId: cfg.fileId,
        fields: "id,name,mimeType,modifiedTime,size,webViewLink",
        supportsAllDrives: true,
      })
      .catch((err: unknown) => {
        throw describeDriveError(err, resource, haveAuth);
      });

    const mimeType = meta.mimeType ?? "application/octet-stream";
    const isNative = mimeType.startsWith(GOOGLE_NATIVE_PREFIX);

    let raw: unknown;
    if (isNative) {
      const exportMime =
        cfg.exportMimeType ?? EXPORT_MIME[mimeType] ?? DEFAULT_NATIVE_EXPORT;
      ({ data: raw } = await client.files
        .export({ fileId: cfg.fileId, mimeType: exportMime })
        .catch((err: unknown) => {
          if (statusOf(err) === 400) {
            throw new Error(
              `Google Drive cannot export "${meta.name ?? cfg.fileId}" (${mimeType}) as "${exportMime}". Set a supported \`exportMimeType\` for this file type.`,
            );
          }
          throw describeDriveError(err, resource, haveAuth);
        }));
    } else {
      ({ data: raw } = await client.files
        .get({ fileId: cfg.fileId, alt: "media", supportsAllDrives: true })
        .catch((err: unknown) => {
          throw describeDriveError(err, resource, haveAuth);
        }));
    }

    const full = coerceText(raw);
    const truncated = full.length > cfg.maxChars;
    const content = truncated
      ? `${full.slice(0, cfg.maxChars)}\n\n... [truncated ${full.length - cfg.maxChars} characters]`
      : full;

    return {
      content,
      truncated,
      file: {
        id: meta.id ?? cfg.fileId,
        name: meta.name ?? "unknown",
        mimeType,
        modifiedTime: meta.modifiedTime ?? null,
        size: meta.size != null ? Number(meta.size) : null,
        webViewLink: meta.webViewLink ?? null,
      },
    };
  },
});

/** Coerce a Drive export/download body into a string. Text exports come back
 *  as a string already; structured bodies are JSON-stringified as a fallback. */
function coerceText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data == null) return "";
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8");
  return JSON.stringify(data);
}
