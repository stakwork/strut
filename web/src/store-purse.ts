// What the store page holds for each publisher's server it runs things on
// (plans/paid-runs.md §10 "The store"): the visitor's credit credential
// there, credentials paid for and not yet sent, and every invoice shown and
// not yet settled — in this page's `sessionStorage`, one purse per server,
// so a reload in the tab keeps the credit spendable and the runs readable.
// Never in a URL; never sent anywhere but its own server. One claim keeper
// per server claims every invoice shown until it settles or ends, whether or
// not its sheet is still open (./visitor-pay `createClaimKeeper`): a phone
// that pays after the visitor pressed Cancel still buys credit, which the
// next run there spends.

import { liveClaim } from "./api";
import { createClaimKeeper, loadPurse, payInTurn, savePurse, type ClaimKeeper, type PayOutcome, type PaymentRequired, type VisitorPurse } from "./visitor-pay";
import { loadRuns, rememberRun, storePurseKey, storeRunsKey, type LaunchedRun } from "./store-run";

export interface StorePurse {
  base: string;
  purse: VisitorPurse;
  save(): void;
  keeper: ClaimKeeper;
  /** One sheet at a time for this server. */
  payTurn: ReturnType<typeof payInTurn>;
  runs(): LaunchedRun[];
  remember(run: LaunchedRun): void;
}

const storage = (() => {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
})();

const purses = new Map<string, StorePurse>();

/** The purse for a publisher's server, made once per page and server. */
export function storePurse(base: string): StorePurse {
  const known = purses.get(base);
  if (known) return known;
  const purse = loadPurse(storage, storePurseKey(base));
  const save = () => savePurse(storage, storePurseKey(base), purse);
  save();
  const keeper = createClaimKeeper({ purse, claim: (macaroon) => liveClaim(base, macaroon), save });
  keeper.resume();
  let runs = loadRuns(storage, storeRunsKey(base));
  const made: StorePurse = {
    base,
    purse,
    save,
    keeper,
    payTurn: payInTurn(purse),
    runs: () => runs,
    remember(run) {
      runs = rememberRun(runs, run);
      try {
        storage?.setItem(storeRunsKey(base), JSON.stringify(runs));
      } catch {
        // Full or refused: this page load still holds them.
      }
    },
  };
  purses.set(base, made);
  return made;
}

/** Show the sheet for a challenge, through the server's one-at-a-time turn:
 *  the invoice is claimed from now until it settles or ends, sheet or no
 *  sheet; a top-up replaces the credential it was minted to carry from. */
export function payWith(
  sp: StorePurse,
  show: (p: PaymentRequired, workflow: string, settled: ReturnType<ClaimKeeper["watch"]>) => Promise<PayOutcome>,
): (p: PaymentRequired, workflow: string) => Promise<PayOutcome> {
  return (p, workflow) =>
    sp.payTurn((q, w) => {
      const settled = sp.keeper.watch({
        macaroon: q.macaroon,
        ...(q.expires ? { expires: q.expires } : {}),
        ...(q.carries && sp.purse.credential ? { carriesFrom: sp.purse.credential } : {}),
      });
      return show(q, w, settled);
    }, p, workflow);
}
