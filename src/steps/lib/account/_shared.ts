/**
 * The `account/*` steps (plans/people-and-hosts.md §2.1): a person's linked
 * accounts and the challenge that links one, over `ctx.services.accounts`
 * (src/people.ts). Strut's own app (the Jamie app's Connect panel) calls them
 * for its viewer.
 *
 * Only as a FIRST-PARTY page's own call (a one-step run, for its viewer), as
 * `secret/add` is: never a model-written page, never an agent's tool. A link
 * challenge is worth the person it names — whoever signs it with their key
 * is linked as them — so no agent may make one: in a tribe that does not
 * show its senders, every turn runs as the tribe's linker.
 */
import { isFirstParty, workflowOf, type StepContext } from "../../../core.js";
import type { AccountsCapability } from "../../../people.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";

export function requireAccounts(type: string, ctx: StepContext | undefined): { accounts: AccountsCapability; actor: string } {
  if (!ctx || !isFirstParty(ctx.app) || !ctx.actor || workflowOf(ctx) !== RUN_STEP_FLOW) {
    throw new Error(`${type} is a person's: it runs only as strut's own app's call, for its viewer (plans/people-and-hosts.md §2.1), never an agent's tool or another app's`);
  }
  const accounts = (ctx.services as { accounts?: AccountsCapability } | undefined)?.accounts;
  if (!accounts) throw new Error(`${type} needs the linked accounts (ctx.services.accounts). The standard strut server provides them.`);
  return { accounts, actor: ctx.actor };
}
