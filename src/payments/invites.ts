/**
 * WORKER INVITES (plans/human-steps.md §5.7): staff invite a new worker with
 * one https link. Strut asks the treasury daemon for a Sphinx invite (the
 * daemon pays the mixer for it, so it goes through the payer, which alone
 * holds the pay token) and hands staff
 *
 *     https://<public view>/public/join#action=i&d=…&c=…&a=<worker app URL>
 *
 * The invite rides after `#`, so it never reaches a server; `/public/join`
 * (src/public-join.ts) turns it back into `sphinx.chat://?action=i&…` for
 * Peel. `a=` is strut's own section, in the link alone: the worker app's
 * address in the public view, percent-encoded, which Peel opens once the
 * worker is signed up (or at once, for a Peel user). The mixer keeps only
 * code → starting sats, and the core's parser ignores a section it does not
 * know.
 *
 * Nothing is kept here: the daemon keeps the invites, and the task store
 * nothing new — task types are open by default (ruling 9), so the worker's
 * first `task/next` lets them in.
 *
 * Never on a services bag: only the staff's `/tasks/invites` routes hold it.
 */
import { LightningError } from "./lightning.js";
import { INVITE_CODE, NO_INVITES, type InviteStatus, type Payer, type WalletInvite } from "./payer.js";
import { INVITE_SATS_MAX } from "./ledger.js";

export type InviteErrorCode =
  | "bad_request"
  | "no_worker_app"
  | "pick_app"
  | "no_pay_credential"
  | "no_invites"
  | "unknown_invite"
  | "wallet_unavailable"
  | "wallet_refused";

const STATUS: Record<InviteErrorCode, 400 | 404 | 409 | 501 | 502> = {
  bad_request: 400,
  no_worker_app: 409,
  pick_app: 409,
  no_pay_credential: 409,
  no_invites: 501,
  unknown_invite: 404,
  wallet_unavailable: 502,
  wallet_refused: 409,
};

/** A refusal: `code: sentence`, with the HTTP status its route answers. */
export class InviteError extends Error {
  readonly status: 400 | 404 | 409 | 501 | 502;
  constructor(
    readonly code: InviteErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "InviteError";
    this.status = STATUS[code];
  }
}

/** An invite as staff see it: the daemon's, with `link` the join link. */
export interface InviteView {
  code: string;
  /** `https://<public view>/public/join#…`, when the daemon gave an invite. */
  link?: string;
  sats: number;
  status: InviteStatus;
  createdAt?: string;
}

export interface InvitesList {
  invites: InviteView[];
  /** The worker apps: the apps task types name that are in the public view. */
  apps: string[];
  /** The app the links open: the one asked for, or the only one. */
  app?: string;
  /** What an invite starts a worker with when staff name none. */
  sats: number;
  /** Why this server cannot invite: no pay credential, or a daemon without
   *  the routes. Absent when it can. */
  why?: "no_pay_credential" | "no_invites";
}

export interface InvitesDeps {
  /** The payer now, or null with no pay credential. */
  payer(): Promise<Payer | null>;
  /** The payout settings' `inviteSats`. */
  inviteSats(): Promise<number>;
  /** The apps task types name that are in the public view, sorted. */
  workerApps(): Promise<string[]>;
}

export interface Invites {
  /** A new invite, its link opening `app` (or the one worker app). */
  create(o: { sats?: number; app?: string; base: string }): Promise<InviteView & { app: string }>;
  /** Every invite the daemon keeps, newest first, each link opening `app`. */
  list(o: { app?: string; base: string }): Promise<InvitesList>;
  cancel(code: string): Promise<{ code: string; status: InviteStatus }>;
}

/** A public app's page as a visitor opens it, the page alone: what Peel
 *  opens for `peel://open?url=` (web/src/store-links.ts `liveAppUrl`). */
export function workerAppUrl(base: string, app: string): string {
  const p = new URLSearchParams({ app, solo: "1", public: "1" });
  return `${base.replace(/\/+$/, "")}/?${p.toString()}`;
}

/** The join link for a daemon's invite: its query after `#` (the
 *  `sphinx.chat://?` taken off), then `a=` the worker app's URL, encoded so
 *  its `&` and `=` stay inside the section. Undefined for an invite that is
 *  not `action=i&…`. */
export function joinLink(base: string, invite: string, appUrl?: string): string | undefined {
  const q = invite.trim().replace(/^sphinx\.chat:\/\/\?/i, "");
  if (!/^action=i&/.test(q) || !/(^|&)d=[^&]+/.test(q) || /[#\s]/.test(q)) return undefined;
  return `${base.replace(/\/+$/, "")}/public/join#${q}${appUrl ? `&a=${encodeURIComponent(appUrl)}` : ""}`;
}

/** A wallet's refusal as the route's. */
function fromWallet(err: unknown): never {
  if (err instanceof LightningError) {
    if (err.walletCode === NO_INVITES) throw new InviteError("no_invites", err.message);
    if (err.walletCode === "not_found") throw new InviteError("unknown_invite", err.message);
    if (err.code === "bad_request") throw new InviteError("bad_request", err.message);
    if (err.code === "wallet_refused") throw new InviteError("wallet_refused", err.message);
    throw new InviteError("wallet_unavailable", err.message);
  }
  throw err;
}

export function createInvites(deps: InvitesDeps): Invites {
  /** The app the link opens: the one asked for, which must be a worker
   *  app, or the only one. */
  const appOf = async (asked: string | undefined, apps: string[]): Promise<string | undefined> => {
    if (asked !== undefined) {
      if (!apps.includes(asked)) {
        throw new InviteError("bad_request", `${asked} is not a worker app in the public view${apps.length ? `: one of ${apps.join(", ")}` : ""}`);
      }
      return asked;
    }
    return apps.length === 1 ? apps[0] : undefined;
  };
  const view = (inv: WalletInvite, base: string, app: string | undefined): InviteView => {
    const link = inv.link ? joinLink(base, inv.link, app ? workerAppUrl(base, app) : undefined) : undefined;
    return { code: inv.code, ...(link ? { link } : {}), sats: inv.sats, status: inv.status, ...(inv.createdAt ? { createdAt: inv.createdAt } : {}) };
  };
  const payerOf = async (): Promise<Payer & Required<Pick<Payer, "invite" | "invites" | "cancelInvite">>> => {
    const payer = await deps.payer();
    if (!payer) throw new InviteError("no_pay_credential", "this server's wallet has no pay credential: an invite is paid for by the Sphinx daemon's pay token");
    if (!payer.invite || !payer.invites || !payer.cancelInvite) throw new InviteError("no_invites", "this server's wallet cannot make Sphinx invites: only a Sphinx daemon can");
    return payer as Payer & Required<Pick<Payer, "invite" | "invites" | "cancelInvite">>;
  };

  return {
    async create(o) {
      const sats = o.sats ?? (await deps.inviteSats());
      if (!Number.isSafeInteger(sats) || sats < 1 || sats > INVITE_SATS_MAX) throw new InviteError("bad_request", `sats is a whole number from 1 to ${INVITE_SATS_MAX}`);
      const apps = await deps.workerApps();
      if (!apps.length) {
        throw new InviteError("no_worker_app", "no task type's app is in the public view: make the worker app public first, so the link has somewhere to open");
      }
      const app = await appOf(o.app, apps);
      if (!app) throw new InviteError("pick_app", `the task types name several worker apps: pick one of ${apps.join(", ")}`);
      // Before anything is paid: the wallet that can.
      const payer = await payerOf();
      const inv = await payer.invite({ sats }).catch(fromWallet);
      return { ...view(inv, o.base, app), app };
    },

    async list(o) {
      const [apps, sats] = await Promise.all([deps.workerApps(), deps.inviteSats()]);
      const app = await appOf(o.app, apps);
      const head = { apps, ...(app ? { app } : {}), sats };
      let payer: Awaited<ReturnType<typeof payerOf>>;
      try {
        payer = await payerOf();
      } catch (err) {
        if (err instanceof InviteError && (err.code === "no_pay_credential" || err.code === "no_invites")) return { invites: [], ...head, why: err.code };
        throw err;
      }
      let invites: WalletInvite[];
      try {
        invites = await payer.invites();
      } catch (err) {
        if (err instanceof LightningError && err.walletCode === NO_INVITES) return { invites: [], ...head, why: "no_invites" };
        return fromWallet(err);
      }
      // Newest first; one with no time keeps the daemon's order, last.
      const sorted = invites.map((inv, i) => ({ inv, i })).sort((a, b) => (b.inv.createdAt ?? "").localeCompare(a.inv.createdAt ?? "") || a.i - b.i);
      return { invites: sorted.map(({ inv }) => view(inv, o.base, app)), ...head };
    },

    async cancel(code) {
      if (typeof code !== "string" || !INVITE_CODE.test(code)) throw new InviteError("bad_request", "an invite's code is 1 to 128 letters, digits, - or _");
      const payer = await payerOf();
      return payer.cancelInvite({ code }).catch(fromWallet);
    },
  };
}
