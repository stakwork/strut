import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { newerDay, recentOutput } from "../context/recent.js";
import { requireApps } from "./_shared.js";

/**
 * The `Apps` page of Recent Work (plans/recent-work.md §5): the apps this
 * run's person opened lately (the monitor's call log: the last hour), then
 * the ones they made (`owner`), then every other app on the server — so a
 * person who never opened one still finds `strut/knowledge` by its title.
 */
export default defineStep({
  type: "app/recent",
  description:
    "The apps you most likely mean: { items: [{ name, what (its title, whose it is — you opened it, you made it, on this server — and its description), at? }] }, the ones you opened in the last hour first, then yours, then the rest, each by name. " +
    "app/get for one, app/look to see it.",
  effect: "read",
  input: z.object({}),
  output: recentOutput,
  async run(_cfg, ctx: StepContext<StrutCapabilities>) {
    const apps = requireApps(ctx.services);
    const all = await apps.list();
    const rows = await Promise.all(
      all.map(async (a) => {
        const log = ctx.actor ? await apps.calls(a.name, ctx.actor, { limit: 1 }).catch(() => null) : null;
        return { a, opened: log?.calls.at(-1)?.at, mine: !!ctx.actor && a.owner === ctx.actor };
      }),
    );
    const rank = (r: (typeof rows)[number]) => (r.opened ? 0 : r.mine ? 1 : 2);
    // By the day each was opened, then by name: an app page calling as the
    // person every minute moves no app up (`newerDay`).
    rows.sort((x, y) => rank(x) - rank(y) || newerDay(x.opened, y.opened) || x.a.name.localeCompare(y.a.name));
    return {
      // An admin's app (`admin: true`) only when it is theirs: the rest of
      // the list is what anyone here may mean.
      items: rows.filter((r) => r.opened || r.mine || !r.a.admin).map(({ a, opened, mine }) => ({
        name: a.name,
        // Its title, whose it is, then what it is (cut with the line), so
        // "the app that shows trials" can match too.
        what: `${[a.title, opened ? "you opened it" : mine ? "you made it" : "on this server"].filter(Boolean).join(", ")}${a.description ? `: ${a.description}` : ""}`,
        ...(opened ? { at: opened } : {}),
      })),
    };
  },
});
