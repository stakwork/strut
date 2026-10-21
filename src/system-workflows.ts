import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { automationDraftSchema, normalizeTrigger, type Automation } from "./automations.js";
import { contentHash } from "./version.js";
import type { WorkspaceStore } from "./workspace.js";

/**
 * System workflows: built-in automations strut ships, one folder each under
 * src/workflows/system/<name>/ (copied into build/ with the rest of
 * src/workflows) holding `workflow.yaml` and `automation.json`. On boot each
 * is installed as a workflow of category "system" plus its automation, OFF.
 *
 * A shipped version is labelled `s-<content hash>`. A seed always matches
 * git, so the rules are:
 * - no workflow: create it at the shipped version, with its automation off;
 * - otherwise the shipped version is the active one: published when new,
 *   made active again when it is not (an older shipped version, or a
 *   version edited in strut — kept in the history, active until the next
 *   boot);
 * - no automation on the workflow: recreate it, off;
 * - a workflow of the same name that was never shipped (no `s-` version,
 *   not category system) is the user's own and is left alone.
 * An existing automation (its enabled flag, its trigger, its input) is never
 * touched, except its name: one still carrying a name listed in
 * automation.json's `formerNames` (a name strut shipped before) takes the
 * shipped name. A name the user chose is left alone.
 */
export const SYSTEM_CATEGORY = "system";

/** Who a memory write from inside a system workflow is recorded as. */
export const SYSTEM_WRITER = "janitor";

export const SYSTEM_DIR = fileURLToPath(new URL("./workflows/system/", import.meta.url));

/** The workflows strut ships, one folder each: listed once, at load. */
const SHIPPED = existsSync(SYSTEM_DIR) ? readdirSync(SYSTEM_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

/** Is `name` one of the workflows strut ships? */
export const isSystemWorkflow = (name: string): boolean => SHIPPED.includes(name);

export function shippedVersionLabel(yamlText: string): string {
  return `s-${contentHash(yamlText).slice(0, 8)}`;
}

/** automation.json: an automation draft plus the names strut shipped it under before. */
const shippedAutomationSchema = automationDraftSchema.extend({ formerNames: z.array(z.string()).default([]) });

export type InstallAction = "created" | "updated" | "unchanged" | "skipped";
type Installed = { version: string; action: InstallAction; automation?: string };

/** Install one system workflow. `automationJson` is the parsed automation.json. */
export async function installSystemWorkflow(
  workspace: WorkspaceStore,
  name: string,
  yamlText: string,
  automationJson: unknown,
): Promise<Installed> {
  const label = shippedVersionLabel(yamlText);
  const description = (yaml.load(yamlText) as { description?: string } | null)?.description;
  const { formerNames, ...draft } = shippedAutomationSchema.parse(automationJson);
  const publish = () => workspace.publishWorkflow(name, label, yamlText, description, SYSTEM_CATEGORY, undefined, { source: "seed" });

  const meta = await workspace.getWorkflowMetadata(name);
  let action: InstallAction = "unchanged";
  if (!meta) {
    await publish();
    action = "created";
  } else if (meta.category !== SYSTEM_CATEGORY && !Object.keys(meta.versions).some((v) => v.startsWith("s-"))) {
    // A workflow of this name that strut never shipped is the user's own: leave it.
    return { version: meta.active, action: "skipped" };
  } else {
    if (meta.category !== SYSTEM_CATEGORY) await workspace.setWorkflowCategory(name, SYSTEM_CATEGORY);
    if (!meta.versions[label]) {
      await publish(); // activates it
      action = "updated";
    } else if (meta.active !== label) {
      await workspace.setActiveVersion(name, label);
      action = "updated";
    }
  }

  if (meta?.automations?.length) {
    if (meta.automations.some((a) => formerNames.includes(a.name))) {
      await workspace.setWorkflowAutomations(name, meta.automations.map((a) => (formerNames.includes(a.name) ? { ...a, name: draft.name } : a)));
    }
    return { version: label, action };
  }
  const automation: Automation = {
    id: `a-${randomUUID().slice(0, 8)}`,
    name: draft.name,
    enabled: false,
    trigger: normalizeTrigger(draft.trigger, new Date()),
    input: draft.input ?? {},
  };
  await workspace.setWorkflowAutomations(name, [automation]);
  return { version: label, action, automation: automation.id };
}

/** Install every system workflow strut ships: the boot step `createStrut` runs. */
export async function installSystemWorkflows(workspace: WorkspaceStore): Promise<Array<Installed & { name: string }>> {
  const out = [];
  for (const name of SHIPPED) {
    // One broken folder never keeps the others from installing.
    try {
      const yamlText = await readFile(join(SYSTEM_DIR, name, "workflow.yaml"), "utf-8");
      const automationJson = JSON.parse(await readFile(join(SYSTEM_DIR, name, "automation.json"), "utf-8"));
      out.push({ name, ...(await installSystemWorkflow(workspace, name, yamlText, automationJson)) });
    } catch (err) {
      console.warn(`[system] could not install ${name}:`, err instanceof Error ? err.message : err);
    }
  }
  // A built-in strut no longer ships (removed or renamed) keeps its record,
  // but its automations are switched off: nothing runs that strut did not ship.
  try {
    for (const w of await workspace.listWorkflows()) {
      if (w.category !== SYSTEM_CATEGORY || SHIPPED.includes(w.name) || !w.automations?.some((a) => a.enabled)) continue;
      await workspace.setWorkflowAutomations(w.name, w.automations.map((a) => ({ ...a, enabled: false })));
      console.log(`[system] ${w.name} is no longer shipped: its automations are off`);
    }
  } catch (err) {
    console.warn("[system] could not check for unshipped system workflows:", err instanceof Error ? err.message : err);
  }
  return out;
}
