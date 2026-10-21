import { readFile } from "node:fs/promises";
import type { WorkspaceStore } from "../workspace.js";

/**
 * The browser workflows strut ships beside the `browser/*` steps — the two
 * ways through a site, a declared route (`browser-capture`: one
 * browser/capture call) and an explored one (`browser-explore`: an agent
 * whose tools are the browser/* steps), a scheduled reader
 * (`browser-watch`), and a captcha a person solves (`browser-captcha`). Seeded at boot by `createStrut` the way `job` is
 * (src/job-seed.ts): content-hash publish, so every boot makes the
 * committed copy the active version — a workspace-side edit lasts until the
 * next boot. ONE seeder per name.
 */
export const BROWSER_CATEGORY = "browser";

/** Each shipped workflow (src/workflows/<name>.yaml) and what the sidebar,
 *  `list_workflows` and `meta/list-workflows` say about it. */
export const BROWSER_WORKFLOWS: Record<string, string> = {
  "browser-capture":
    "Photograph a page: open `url`, run the declared `steps` (click, fill, wait, …), settle, screenshot. Input { url, steps?, fullPage?, wait? }; output { path, dir, url, width, height, bytes, errors, pageUrl, title } — the PNG and its served link, the page's console/network errors.",
  "browser-explore":
    "An agent drives a real browser — every browser/* step is one of its tools — to answer a goal on a site, with screenshots as evidence. Input { goal, url, session? }; output { answer, evidence: [{ path, url }], pages, captcha?, cost } — captcha: { session } when a captcha stopped it (run browser-captcha with that session).",
  "browser-captcha":
    "One round of a captcha a person solves, on a page the job keeps: with no answer it crops the challenge and writes the manifest the person's card reads; with the person's answer it taps or types it, verifies and looks. Never solves one itself. Input { session, answer? }; output { status: ask | solved | failed, artifact?, round, note }.",
  "browser-watch":
    "Read a region of a page, compare it with what the previous run saw, and have an llm say what changed; schedule it with previous set to the last run's output text. Input { url, selector?, previous? }; output { text, changed, summary }.",
};

/** Seed every browser workflow: the boot step `createStrut` runs. One that
 *  will not take is a warning, never a failed boot. */
export async function seedBrowserWorkflows(workspace: WorkspaceStore): Promise<Array<{ name: string; version: string; changed: boolean }>> {
  const out = [];
  for (const [name, description] of Object.entries(BROWSER_WORKFLOWS)) {
    try {
      const text = await readFile(new URL(`../workflows/${name}.yaml`, import.meta.url), "utf-8");
      const r = await workspace.publishWorkflowByContent(name, text, description, BROWSER_CATEGORY, undefined, { source: "seed" });
      out.push({ name, ...r });
    } catch (err) {
      console.warn(`[browser] could not seed workflow "${name}":`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
