import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

/** Remove an app. Only as a proposal a person accepted (as app/grant). */
export default defineStep({
  type: "app/delete",
  description:
    "Delete a published APP: its versions, releases, grants and saved page state. Not reversible. Only on a person's yes: the call becomes a proposal the person approves, and the app is removed then. " +
    "Propose it to retire an old app once its replacement is published. Returns { name, deleted: true }.",
  input: z.object({ name: z.string().min(1).describe("The app's name, as app/list gives it") }),
  output: z.object({ name: z.string(), deleted: z.literal(true) }),
  async describe(cfg, ctx) {
    const fields: Array<{ label: string; value: string; kind?: "ref"; danger?: boolean }> = [{ label: "app", value: cfg.name, kind: "ref", danger: true }];
    const app = await requireApps(ctx.services).get(cfg.name).catch(() => null);
    if (app) {
      fields.push({ label: "versions", value: Object.keys(app.versions).join(", "), danger: true });
      fields.push({ label: "live", value: app.live ? `${app.live} (held)` : `latest · ${app.active}`, danger: true });
    }
    fields.push({ label: "removes", value: "The app, its grants and its saved page state are removed. This is not reversible.", danger: true });
    return { title: `Delete app ${cfg.name}`, fields, actions: { accept: "Delete", reject: "Keep" } };
  },
  async run(cfg, ctx) {
    if (!ctx.proposal) throw new Error("app/delete runs only as a proposal a person accepted: a person deletes an app, never a tool call.");
    if (!(await requireApps(ctx.services).delete(cfg.name))) throw new Error(`App "${cfg.name}" not found`);
    return { name: cfg.name, deleted: true as const };
  },
});
