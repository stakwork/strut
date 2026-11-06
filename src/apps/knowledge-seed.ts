/**
 * `strut/knowledge` (plans/knowledge-app.md): the organisation's Concept
 * tree and its graph — what Hive's org graph view showed — as an app strut
 * ships, seeded at boot after `strut/views` (whose components it imports) by
 * the same tree hash (./views-seed.ts). First-party like `strut/jamie`
 * (src/apps/tools.ts `firstPartyApp`): it reads as its viewer.
 * `knowledge: false` seeds nothing.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceStore } from "../workspace.js";
import type { Kit, KitLocation } from "./kit.js";
import { VIEWS_APP, seedBundledApp } from "./views-seed.js";

export const KNOWLEDGE_APP = "strut/knowledge";
/** The app's sources: `src/apps/knowledge/` (`build/apps/knowledge/` once built). */
export const KNOWLEDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "knowledge");

export interface KnowledgeSeedOptions {
  workspace: WorkspaceStore;
  kit?: Kit | KitLocation;
  dir?: string;
  cacheDir?: string;
}

/** Seed `strut/knowledge`. Null when there is no built kit, or no
 *  `strut/views` to build it against (`views: false`). */
export async function seedKnowledgeApp(opts: KnowledgeSeedOptions): Promise<{ version: string; changed: boolean } | null> {
  if (!(await opts.workspace.getApp(VIEWS_APP).catch(() => null))) return null;
  return seedBundledApp({
    workspace: opts.workspace,
    name: KNOWLEDGE_APP,
    dir: opts.dir ?? KNOWLEDGE_DIR,
    ...(opts.kit ? { kit: opts.kit } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
}
