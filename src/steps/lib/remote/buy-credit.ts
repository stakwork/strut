import { z } from "zod";
import type { CardField } from "../../../core.js";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { sellerOf, usdText, type RemoteListing, type RemoteRunnable } from "../../../remote.js";

/**
 * BUY credit at another strut server (plans/paid-runs.md §10 "Another
 * strut", decision 16): an agent never pays by itself. The step runs ONLY
 * as a proposal a person accepted, and that person an ADMIN
 * (`approver: "admin"`, as `package/install`): a direct tool call, a DAG
 * step, `meta/run-step` or a subflow is refused, and the door behind it
 * (`ctx.services.remote.buyCredit`, src/remote.ts) checks the accepted
 * record on disk for this seller and amount, so a forged `ctx.proposal`
 * opens nothing.
 *
 * The CARD (decision 25) reads the seller's public door at proposal time:
 * who, what it sells, each price and what recent runs were charged, what
 * this strut holds there now, and whether this strut's wallet can pay at
 * all. On accept strut asks the seller for the credit, checks its quote,
 * pays the invoice through the wallet's payer (one payment, booked as a
 * purchase in Earnings), and keeps the token; a payment that has not
 * settled yet is claimed every minute until it does. Agents and
 * automations then spend it with remote/run-workflow and remote/call, with
 * no ask.
 */

const input = z.object({
  url: z.string().describe("The seller: a strut server's base URL, https (what remote/list was given)."),
  usd: z
    .number()
    .min(0.01)
    .max(1000)
    .describe("How many dollars of credit to buy there (0.01 to 1000) — at least what the runs to come need: a run sets its item's `reserve` aside to start."),
});

/** The card's read of the seller, at most: the agent's turn waits on it. */
const DESCRIBE_WAIT_MS = 10_000;

/** `p`, or an error once `ms` passed (the read goes on, unheard). */
function within<T>(p: Promise<T>, ms: number): Promise<T | Error> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Error>((resolve) => {
    timer = setTimeout(() => resolve(new Error(`no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([p.catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))), late]).finally(() => clearTimeout(timer));
}

const priceLine = (i: RemoteRunnable): string => {
  const price =
    !i.base && !i.markup
      ? "free"
      : [i.base ? `${usdText(i.base)} a ${i.kind === "step" ? "call" : "run"}` : "", i.markup ? `${i.markup}× its cost` : ""].filter(Boolean).join(" + ");
  const recent = i.recent?.runs ? `; ${i.recent.runs} in ${i.recent.days} days, ${usdText(i.recent.average)} on average` : "";
  return `${i.name} (${i.kind}): ${price}, ${usdText(i.reserve)} to start${recent}`;
};

export default defineStep({
  type: "remote/buy-credit",
  effect: "write",
  approver: "admin",
  description:
    "Buy credit at another strut server — dollars of credit its public door sells over Lightning — so remote/run-workflow and remote/call can spend it there. " +
    "The call becomes a proposal an ADMIN of this strut server approves on a card that says who the seller is, what it sells at what price, what recent runs were charged and what is held there now; " +
    "strut pays from this server's wallet when they accept, and tells you the result on a later turn. Read what the seller sells with remote/list first, and put the reason in `rationale`, in the person's terms. " +
    "Never pays on its own: a direct call is refused. When the person is not an admin, the call is refused (admin_required:) — tell them an admin buys credit, and to ask one.",
  input,
  output: z.any(),
  async describe(cfg, ctx: StepContext<StrutCapabilities>) {
    let seller: string;
    try {
      seller = ctx.services?.remote ? ctx.services.remote.seller(cfg.url) : sellerOf(cfg.url);
    } catch (err) {
      return { title: `Buy ${usdText(cfg.usd)} of credit`, summary: err instanceof Error ? err.message : String(err) };
    }
    const host = new URL(seller).host;
    const title = `Buy ${usdText(cfg.usd)} of credit at ${host}`;
    const remote = ctx.services?.remote;
    if (!remote) return { title };
    const [listing, canPay] = await Promise.all([within(remote.list(seller), DESCRIBE_WAIT_MS), remote.canPay().catch(() => false)]);
    const lines: string[] = [];
    const fields: CardField[] = [{ label: "Seller", value: seller, kind: "ref" }, { label: "Amount", value: `${usdText(cfg.usd)} of credit, paid in sats at the rate when it is bought` }];
    if (listing instanceof Error) {
      lines.push(`${seller} could not be read (${listing.message.slice(0, 200)}): what it sells is not known.`);
      fields.push({ label: "Sells", value: "could not be read", danger: true });
    } else {
      const l = listing as RemoteListing;
      const priced = l.runnable.filter((i) => i.base || i.markup);
      lines.push(
        l.runnable.length
          ? `${seller} sells ${l.runnable.length} thing${l.runnable.length === 1 ? "" : "s"} to run (${priced.length} priced): ${l.runnable.slice(0, 5).map(priceLine).join("; ")}${l.runnable.length > 5 ? `; and ${l.runnable.length - 5} more` : ""}.`
          : `${seller} lists nothing anyone may run.`,
      );
      fields.push({ label: "Sells", value: l.runnable.length ? l.runnable.slice(0, 8).map(priceLine).join("\n") : "nothing", ...(l.runnable.length ? {} : { danger: true }) });
      const c = l.credit;
      const held = c.held ? (c.remaining_usd !== undefined ? `${usdText(c.remaining_usd)} of credit${c.expires ? `, until ${c.expires.slice(0, 10)}` : ""}` : `a token${c.error ? ` the seller did not read (${c.error.slice(0, 120)})` : ""}`) : "no credit";
      lines.push(`This strut server holds ${held} there${c.held && c.remaining_usd !== undefined ? "; what is left carries to the new token" : ""}.`);
      fields.push({ label: "Held there now", value: held });
      if (c.buying) lines.push(`A purchase of ${usdText(c.buying.usd)} from it is still being paid: this one waits for it.`);
    }
    if (canPay) {
      lines.push("Paid from this strut server's wallet; the sats show as a purchase in Earnings. Credit lasts a year from its purchase.");
      fields.push({ label: "Pays from", value: "this strut server's wallet" });
    } else {
      lines.push("This strut server's wallet has no pay credential: accepting pays nothing until one is set (Earnings → Wallet).");
      fields.push({ label: "Pays from", value: "nothing — the wallet cannot pay", danger: true });
    }
    return { title, summary: lines.join(" "), fields, actions: { accept: "Buy", reject: "Don't buy" }, full: !(listing instanceof Error) };
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.proposal) {
      throw new Error(
        "remote/buy-credit runs only as a proposal a person accepted: paying another strut server is an admin's decision, never a tool call. " +
          "Ask for it as a tool call the person approves (the agent's approve: list names it); a workflow step, meta/run-step or a subflow cannot reach it.",
      );
    }
    const remote = ctx.services?.remote;
    if (!remote) throw new Error("remote/buy-credit needs strut's remote door (ctx.services.remote); the standard strut server provides it.");
    return remote.buyCredit(cfg.url, cfg.usd, { proposal: ctx.proposal.id, ...(ctx.actor ? { actor: ctx.actor } : {}) });
  },
});
