/**
 * `strut/assistant` (plans/jamie-app.md §5): the person's assistant — the
 * `orchestrator`'s conversations, their jobs, proposals and deliverables —
 * as an app strut ships, seeded at boot beside `strut/views` (whose
 * components it imports) by the same tree hash (./views-seed.ts). A
 * `strut/` app at a version strut seeded is FIRST-PARTY
 * (src/apps/tools.ts `firstPartyApp`): its page acts with its viewer's own
 * rights.
 *
 * Its title is the deployment's (`createStrut({ assistant: { title } })`,
 * `STRUT_HOST_CONFIG`'s `assistant.title`; Hive's org page says "Jamie"):
 * the sources are staged with the title written into `app.yaml` and
 * `src/deployment.ts`, so the version is the tree of what was published,
 * and another title is another version. `assistant: false` seeds nothing.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { VIEWS_APP, seedBundledApp } from "./views-seed.js";

export const ASSISTANT_APP = "strut/assistant";
/** The app's sources: `src/apps/assistant/` (`build/apps/assistant/` once built). */
export const ASSISTANT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "assistant");
/** The title when the deployment names none. */
export const ASSISTANT_DEFAULT_TITLE = "Assistant";
/** At most, as a person reads it in a header. */
const TITLE_MAX = 60;

export interface AssistantOptions {
  /** What the assistant is called here ("Jamie"). */
  title?: string;
}

export interface AssistantSeedOptions extends AssistantOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** A title as the app shows it: one line, trimmed, cut. */
export function assistantTitle(title: string | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  return (t || ASSISTANT_DEFAULT_TITLE).slice(0, TITLE_MAX);
}

/** The sources with the deployment's title written in: `app.yaml`'s
 *  `title:` and `src/deployment.ts`. The checked-in files carry the default
 *  (a seed with no title publishes them as they are). */
export async function stageAssistant(src: string, title: string): Promise<{ dir: string; done: () => Promise<void> }> {
  const yaml = await readFile(join(src, "app.yaml"), "utf8");
  if (title === ASSISTANT_DEFAULT_TITLE) return { dir: src, done: async () => {} };
  const tmp = await mkdtemp(join(tmpdir(), "strut-assistant-"));
  const dir = join(tmp, "app");
  await cp(src, dir, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("dist") });
  await writeFile(join(dir, "app.yaml"), yaml.replace(/^title:.*$/m, `title: ${JSON.stringify(title)}`));
  await writeFile(join(dir, "src", "deployment.ts"), deploymentSource(title));
  return { dir, done: () => rm(tmp, { recursive: true, force: true }) };
}

/** `src/deployment.ts` for a title: what the page reads it from. */
export function deploymentSource(title: string): string {
  return `// What this deployment calls its assistant: written by the seed
// (src/apps/assistant-seed.ts) from createStrut({ assistant: { title } }).
export const TITLE = ${JSON.stringify(title)};
`;
}

/** Seed `strut/assistant`: the boot step `createStrut` runs after
 *  `strut/views`. Null when there is no built kit to build it with, or no
 *  `strut/views` to build it against (`views: false`). */
export async function seedAssistantApp(opts: AssistantSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  if (!(await opts.workspace.getApp(VIEWS_APP).catch(() => null))) return null;
  const staged = await stageAssistant(opts.dir ?? ASSISTANT_DIR, assistantTitle(opts.title));
  try {
    return await seedBundledApp({
      workspace: opts.workspace,
      name: ASSISTANT_APP,
      dir: staged.dir,
      ...(opts.kit ? { kit: opts.kit } : {}),
      ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
    });
  } finally {
    await staged.done();
  }
}
