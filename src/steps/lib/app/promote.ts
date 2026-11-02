import { z } from "zod";
import { defineStep } from "../../../core.js";
import { requireApps } from "./_shared.js";

const one = (c: { version?: string; release?: string; follow_latest?: boolean }) => [c.version, c.release, c.follow_latest].filter((x) => x !== undefined && x !== false).length === 1;

/** Change what people open. Only as a proposal a person accepted (as app/grant). */
export default defineStep({
  type: "app/promote",
  description:
    "Change which version of an APP is live for people. Exactly one of: `version` (\"vN\", a draft: make a release of it live and hold the app there), `release` (\"rN\": roll back or forward to an earlier release), " +
    "`follow_latest: true` (lift the hold: every publish is live again). Only on a person's yes: the call becomes a proposal the person approves. " +
    "Propose it to make a draft live after a held app was republished. Returns { name, live, active, release? }.",
  input: z
    .object({
      name: z.string().min(1).describe("The app's name"),
      version: z.string().regex(/^v\d+$/).optional().describe("A published version, e.g. v3"),
      release: z.string().regex(/^r\d+$/).optional().describe("An earlier release, e.g. r1"),
      follow_latest: z.boolean().optional().describe("true: follow the newest publish again"),
    })
    .refine(one, { message: "give exactly one of version, release, follow_latest" }),
  output: z.object({ name: z.string(), live: z.string(), active: z.string(), release: z.string().optional() }),
  async describe(cfg, ctx) {
    const app = await requireApps(ctx.services).get(cfg.name).catch(() => null);
    const now = app ? (app.live ? `${app.live} (${app.active}), held` : `latest (${app.active})`) : "unknown";
    const next = cfg.version ? `${cfg.version}, made a release and held` : cfg.release ? `release ${cfg.release}` : "the newest publish, following latest";
    return {
      title: `Make ${next.split(",")[0]} live for app ${cfg.name}`,
      fields: [
        { label: "app", value: cfg.name, kind: "ref", danger: true },
        { label: "live now", value: now },
        { label: "live after", value: next, danger: true },
      ],
      actions: { accept: "Make live", reject: "Not now" },
    };
  },
  async run(cfg, ctx) {
    if (!ctx.proposal) throw new Error("app/promote runs only as a proposal a person accepted: a person decides what is live, never a tool call.");
    if (!one(cfg)) throw new Error("app/promote: give exactly one of version, release, follow_latest");
    const apps = requireApps(ctx.services);
    let release: string | undefined;
    if (cfg.version) {
      release = (await apps.promote(cfg.name, cfg.version, ctx.actor ? { by: ctx.actor } : {})).id;
    } else await apps.setLive(cfg.name, cfg.release ?? null);
    const app = await apps.get(cfg.name);
    return { name: cfg.name, live: app?.live ?? "latest", active: app?.active ?? "", ...(release ? { release } : {}) };
  },
});
