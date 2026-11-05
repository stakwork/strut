/**
 * The `conversation/*` steps are thin over the conversation index
 * (`src/conversations.ts`) that `createStrut` builds into
 * `ctx.services.conversations` — the same reads and writes `GET
 * /conversations` and its routes serve. The viewer is the step's actor.
 *
 * Refused from an app's page (`ctx.app`): a page is code a model wrote, and
 * a person's conversations are theirs. The first-party tier
 * (plans/jamie-app.md §3) opens them to strut's own app.
 */
import type { ConversationViewer, ConversationsCapability } from "../../../conversations.js";

export function requireConversations(ctx: { services?: unknown; app?: unknown; actor?: string }): {
  conversations: ConversationsCapability;
  viewer: ConversationViewer;
} {
  if (ctx.app) throw new Error("conversation/* steps are not available to an app's page (strut's own app gets them: plans/jamie-app.md §3)");
  const conversations = (ctx.services as { conversations?: ConversationsCapability } | undefined)?.conversations;
  if (!conversations) {
    throw new Error("conversation/* steps need the conversation index (ctx.services.conversations). The standard strut server provides it.");
  }
  return { conversations, viewer: ctx.actor ? { actor: ctx.actor } : {} };
}
