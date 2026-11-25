import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

export default defineStep({
  type: "app/list",
  description:
    "Every APP on this server (plans/apps.md): { name, activeVersion, versions, title, description?, icon?, grants, publisher?, owner?, origin? }. " +
    "`origin` says where an app comes from, which is where a change to it goes: absent, it was made here and is changed here; `repo <address>, opened here`, it is changed here in place and reaches that repository with package/commit; " +
    "`package <name>`, a change here is this server's own copy; `strut's own, from <address>`, it comes with the server and the next boot puts it back: when that repository is one of the person's, a change to it is a change to its code there, else it is changed as a copy under a name of your own (app/init with it as `template`). " +
    "An app is a front-end project over workflows, published as a versioned directory; another app may import one by name (`import { X } from \"<name>\"`), so this is also the list of installed kits.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    const apps = requireApps(ctx.services);
    return {
      apps: await Promise.all(
        (await apps.list()).map(async (a) => {
          const origin = await apps.origin?.(a.name);
          return origin ? { ...a, origin } : a;
        }),
      ),
    };
  },
});
