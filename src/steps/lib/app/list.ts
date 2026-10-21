import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

export default defineStep({
  type: "app/list",
  description:
    "Every workspace APP (plans/apps.md): { name, activeVersion, versions, title, description?, icon?, grants, publisher?, owner? }. " +
    "An app is a front-end project over workflows, published as a versioned directory; another app may import one by name (`import { X } from \"<name>\"`), so this is also the list of installed kits.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    return { apps: await requireApps(ctx.services).list() };
  },
});
