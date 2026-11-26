import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { AppShare, PublicViewCapability } from "../../../public-view.js";
import { staffCall } from "./_door.js";

/** A type's `share`: where its workers answer it (its app), whether that app
 *  is in the public view, and when it is, its two links and the Peel one as a
 *  QR code (an SVG, white on black, a quiet zone round it). */
export interface TypeShare extends AppShare {
  qrSvg?: string;
}

/** `staff/types` (plans/human-steps.md §9.3): The task types, each with its
 *  app's share (§9.5), and Tasks' own share (`tasks`): every invite opens
 *  Tasks, and its link is the one for a group. */
export default defineStep({
  type: "staff/types",
  effect: "read",
  description:
    "The task types (GET /tasks/types): each with its app, answer shape, lease, expiry, on or off, pay and hold, tests and copies, and `share`: whether its app is in the public view, and its links for workers (`link`, `peelLink`, a QR of the Peel one); and `tasks`, the same for Tasks (strut/tasks), the page every invite opens. Only strut's own Workers app, shown to an admin.",
  input: z.object({}),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const out = await staffCall(ctx, "staff/types", "GET", "/tasks/types");
    const door = (ctx?.services as { publicView?: Partial<PublicViewCapability> } | undefined)?.publicView;
    const types = out["types"];
    // A host's own public view door may have no share read: no `share`.
    if (typeof door?.share !== "function" || !Array.isArray(types)) return out;
    const { qrSvg } = await import("../../../move/link.js");
    const shares = new Map<string, Promise<TypeShare | null>>();
    const shareOf = (app: string) => {
      let s = shares.get(app);
      if (!s) {
        s = door.share!(app)
          .then((x) => (x.peelLink ? { ...x, qrSvg: qrSvg(x.peelLink) } : x))
          .catch(() => null);
        shares.set(app, s);
      }
      return s;
    };
    const withShare = await Promise.all(
      types.map(async (t: Record<string, unknown>) => {
        const share = typeof t["app"] === "string" && t["app"] ? await shareOf(t["app"]) : null;
        return share ? { ...t, share } : t;
      }),
    );
    const { TASKS_APP } = await import("../../../apps/tasks-seed.js");
    const tasks = await shareOf(TASKS_APP);
    return { ...out, types: withShare, ...(tasks ? { tasks } : {}) };
  },
});
