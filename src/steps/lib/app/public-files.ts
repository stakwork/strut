import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { headTail, JOB_READ_MAX_CHARS } from "../../../job-index.js";
import { treeFiles } from "../../../version.js";
import { requireApps } from "./_shared.js";

/**
 * What anyone can open of an app, read as its sources (plans/support-ai.md
 * §2.2): the apps in the PUBLIC VIEW, each at the version people open, which
 * is the version `/public/apps` serves (`apps.versionDir` with no version).
 * Never a private app, never another version. `app/get`, narrowed to what a
 * visitor's browser already loads, for an agent answering someone who only
 * sees that (Support's reply turn, the support job).
 *
 * A version's files are its TREE (`treeFiles`): the sources, never `dist/`
 * (the built document, derived from them), the app's own `data.db`, dotfiles
 * or `node_modules/`. A path is read only when it is in that list, so nothing
 * outside the tree is reached.
 */
export default defineStep({
  type: "app/public-files",
  effect: "read",
  description:
    "Read the apps in this server's PUBLIC VIEW, as their sources, each at the version people open now — what anyone with the link can open, and nothing private. " +
    "With no `app`: { apps: [{ app, version, title, description? }] }. " +
    "With `app`: { app, version, files: [{ path, size, sha }] } — the version's source files (not dist/), each with the sha256 of its bytes, so a later read can tell what changed. " +
    `With \`app\` and \`path\`: { app, version, path, size, sha, text } — one file's text, cut to maxChars (default ${JOB_READ_MAX_CHARS}) keeping its head and tail, \`truncated: true\` when cut; a file that is not text says \`binary: true\` instead. ` +
    "An app that is not in the public view is refused (not_public:).",
  input: z
    .object({
      app: z.string().min(1).optional().describe("An app in the public view, by name (from the list this step gives with no app)."),
      path: z.string().min(1).optional().describe("With `app`: one of its files, as the list gives it."),
      maxChars: z.number().int().positive().optional().describe(`Cap on a text file's content (default ${JOB_READ_MAX_CHARS}).`),
    })
    .refine((q) => !q.path || !!q.app, { message: "app/public-files: `path` needs `app`" }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const apps = requireApps(ctx.services);
    const publicView = ctx.services?.publicView;
    if (!publicView?.apps) throw new Error("app/public-files needs this server's public view (ctx.services.publicView, with apps())");
    const listed = await publicView.apps();

    if (!cfg.app) {
      const out: Array<{ app: string; version: string; title: string; description?: string }> = [];
      for (const name of listed) {
        const m = await apps.manifestOf(name).catch(() => null);
        if (!m) continue;
        out.push({ app: name, version: m.version, title: m.manifest.title, ...(m.manifest.description ? { description: m.manifest.description } : {}) });
      }
      return { apps: out };
    }

    const name = cfg.app;
    if (!listed.includes(name)) throw new Error(`not_public: app "${name}" is not in this server's public view — app/public-files reads only what anyone can open (call it with no app for the list)`);
    const dir = await apps.versionDir(name);
    if (!dir) throw new Error(`not_public: app "${name}" is in the public view but has no version on this server`);
    const paths = await treeFiles(dir.path);

    if (!cfg.path) {
      const files = await Promise.all(
        paths.map(async (path) => {
          const bytes = await readFile(join(dir.path, path));
          return { path, size: bytes.byteLength, sha: createHash("sha256").update(bytes).digest("hex") };
        }),
      );
      return { app: name, version: dir.version, files };
    }

    const path = cfg.path.replace(/^\.?\//, "");
    if (!paths.includes(path)) throw new Error(`No file "${cfg.path}" in ${name}@${dir.version}'s sources (call it with app alone for the list)`);
    const bytes = await readFile(join(dir.path, path));
    const head = { app: name, version: dir.version, path, size: bytes.byteLength, sha: createHash("sha256").update(bytes).digest("hex") };
    if (bytes.includes(0)) return { ...head, binary: true };
    return { ...head, ...headTail(bytes.toString("utf8"), cfg.maxChars ?? JOB_READ_MAX_CHARS) };
  },
});
