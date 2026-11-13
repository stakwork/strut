import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { makePublicCard, makePublicInput } from "../../../public-view.js";

/**
 * The builder or the assistant ASKS to put an app in the PUBLIC VIEW; an
 * ADMIN says yes (plans/public-surface.md §2 "The door", ruled 2026-11-13).
 * The public view is a person's decision, as a sealed grant is: the step
 * runs ONLY as a proposal an admin accepted (`ctx.proposal`, `approver:
 * "admin"`), as `app/grant`, `package/install` and `task/set-type` do. A
 * direct tool call, a workflow's step, `meta/run-step` and a subflow are
 * refused, and the door behind it (`ctx.services.publicView.addApp`,
 * src/public-view.ts) checks the accepted record on disk for this app and
 * version, so a forged `ctx.proposal` opens nothing.
 *
 * The yes adds the app as the Public view tab does when nobody unticks
 * anything: held at the version asked (the one live when asked, which the
 * card pins on the record), with the lines `publicViewNeeds` pre-checks,
 * through `PUT /public-view`'s own save and its checks. It removes nothing
 * and leaves the sign-in as it is: a view that names none offers Sphinx with
 * the root key once an app is public. A served box refuses it
 * (`serve_owned:`).
 *
 * The CARD (`describe`) says the app and version, what anyone will see —
 * each cascade line with what it exposes — who can sign in, and that the app
 * is held at that version.
 */
export default defineStep({
  type: "app/make-public",
  effect: "write",
  approver: "admin",
  description:
    "Ask an admin to put an app in this server's PUBLIC VIEW, where anyone with the link opens it and signed-in visitors (a worker app's workers, through Sphinx) use it. " +
    "The call becomes a proposal an ADMIN approves on a card that shows the app and version, every workflow, read, step and Concept tree it brings into view with what each exposes, and who can sign in; " +
    "strut adds it when they accept, held at that version, and tells you the result on a later turn. Ask once the app is published and ready (a worker app: once it draws its task types). " +
    "Pass the version app/publish answered. Say in your reply that later publishes are drafts until someone makes them live. Put the reason in `rationale`, in the person's terms. " +
    "Never changes the view on its own: a direct call is refused. When the person is not an admin, the call is refused (admin_required:) — tell them an admin makes an app public (Publish → Public view), and to ask one.",
  input: makePublicInput,
  output: z.any(),
  async describe(cfg, ctx: StepContext<StrutCapabilities>) {
    const cap = ctx.services?.publicView;
    return makePublicCard(cfg, cap ? await cap.plan(cfg.name, cfg.version).catch(() => undefined) : undefined);
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.proposal) {
      throw new Error(
        "app/make-public runs only as a proposal an admin accepted: what this server shows anyone is a person's decision, never a tool call. " +
          "Ask for it as a tool call the person approves (the agent's approve: list names it); a workflow step, meta/run-step or a subflow cannot reach it.",
      );
    }
    const door = ctx.services?.publicView;
    if (!door) throw new Error("app/make-public needs strut's public view door (ctx.services.publicView); the standard strut server provides it.");
    if (!cfg.version) throw new Error(`app/make-public: the proposal names no version of ${cfg.name} (none was live when it was asked) — ask again once the app is published`);
    return door.addApp(cfg.name, cfg.version, { proposal: ctx.proposal.id, ...(ctx.actor ? { actor: ctx.actor } : {}) });
  },
});
