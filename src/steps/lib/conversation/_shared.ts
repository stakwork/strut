/**
 * The `conversation/*` steps are thin over the conversation index
 * (`src/conversations.ts`) that `createStrut` builds into
 * `ctx.services.conversations` — the same reads and writes `GET
 * /conversations` and its routes serve. The viewer is the step's actor.
 *
 * Refused from an app's page (`ctx.app`): a page is code a model wrote, and
 * a person's conversations are theirs. A FIRST-PARTY page (strut's own app,
 * plans/jamie-app.md §3) reads them as its viewer's person token does. Any
 * page its manifest grants it may ask `conversation/list { about }`: its
 * viewer's chats about one node (plans/package-seams.md §7), how an app finds
 * "the chat about this" one it started (`conversation/start`).
 *
 * `everyone` (`conversation/list`, `get`, `fork`; plans/jamie-app.md §2.3)
 * reads every person's conversations, as `knowledge/cycles` reads what the
 * dream learned from them: only strut's own page, shown to an ADMIN of this
 * server (`AppRef.admin`), in the page's own call — never a member's page, a
 * person token, a model-written page, a workflow, an agent's tool or a run
 * the page launched.
 */
import { isFirstParty, workflowOf, type AppRef } from "../../../core.js";
import type { ConversationViewer, ConversationsCapability } from "../../../conversations.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";

/** The `everyone` field of the steps that take it. */
export const EVERYONE_DESCRIPTION =
  "An admin's read of every person's conversations on this strut (not only the viewer's), as a reader: nothing read becomes theirs or moves anyone's unread. " +
  "Only strut's own page, shown to an admin of this server, may ask for it.";

/** Is this call strut's own page, shown to an admin, in its own call? */
export function adminPageCall(ctx: { app?: AppRef; path?: string; workflow?: string }): boolean {
  return isFirstParty(ctx.app) && ctx.app?.admin === true && workflowOf(ctx) === RUN_STEP_FLOW;
}

export function requireConversations(
  ctx: { services?: unknown; app?: AppRef; actor?: string; path?: string; workflow?: string },
  ask: { type?: string; everyone?: boolean; about?: boolean } = {},
): {
  conversations: ConversationsCapability;
  viewer: ConversationViewer;
} {
  if (ctx.app && !isFirstParty(ctx.app) && !(ask.about && ctx.actor)) {
    throw new Error("conversation/* steps are not available to an app's page (strut's own app gets them: plans/jamie-app.md §3); a page may ask conversation/list { about } for its viewer's chats about a node");
  }
  const conversations = (ctx.services as { conversations?: ConversationsCapability } | undefined)?.conversations;
  if (!conversations) {
    throw new Error("conversation/* steps need the conversation index (ctx.services.conversations). The standard strut server provides it.");
  }
  if (ask.everyone && !adminPageCall(ctx)) {
    throw new Error(
      `${ask.type ?? "conversation/*"} { everyone } is an admin's: only strut's own page, shown to an admin of this server, reads every person's conversations (plans/jamie-app.md §2.3)`,
    );
  }
  const viewer: ConversationViewer = ctx.app ? { actor: ctx.actor!, person: true } : ctx.actor ? { actor: ctx.actor } : {};
  return { conversations, viewer: ask.everyone ? { ...viewer, everyone: true } : viewer };
}
