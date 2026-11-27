/**
 * WORKER INVITES (plans/human-steps.md §5.8): staff invite a worker with
 * one https link. Strut asks the treasury daemon for a Sphinx invite (the
 * daemon pays the mixer for it, so it goes through the payer, which alone
 * holds the pay token) and hands staff
 *
 *     https://<public view>/public/join#action=i&d=…&c=…&a=<Tasks' URL>
 *
 * The invite rides after `#`, so it never reaches a server; `/public/join`
 * (src/public-join.ts) turns it back into `sphinx.chat://?action=i&…` for
 * Peel. `a=` is strut's own section, in the link alone: the share `link` of
 * TASKS (`strut/tasks`, `publicAppLinks`), percent-encoded, which Peel
 * opens once the worker is signed up (or at once, for someone who has Peel
 * already: Peel ignores the invite then). Every link opens Tasks, the
 * server's one work page, so a worker keeps one page per employer; the kind
 * of work an invite is FOR rides along (`type=`), and Tasks opens it — in
 * the app that draws it, with Back to Tasks. The mixer keeps only code →
 * starting sats, and the core's parser ignores a section it does not know.
 *
 * Tasks' URL carries the invite's own token (`input=invite=…`, auth.ts
 * `inviteToken`), handed to the page as its tool input: the page sends it
 * with `task/me` and `task/next`, and the task service gives that worker
 * the invite's kind of work when it is INVITE-ONLY (`enterInvite`), one
 * worker per invite, while the daemon still has it. An invite for open
 * work, or for none, gives no grant: open work lets anyone in on their
 * first `task/next` (ruling 9).
 *
 * The daemon keeps the invites (code, sats, status); strut keeps only what
 * each was for (`InviteNotes`, the kind of work), so a listing hands out
 * the link the worker was sent, and the task store keeps the grant an
 * invite made (`by: invite:<code>`).
 *
 * Never on a services bag: only the staff's `/tasks/invites` routes hold it.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LightningError } from "./lightning.js";
import { INVITE_CODE, NO_INVITES, type InviteStatus, type Payer, type WalletInvite } from "./payer.js";
import { INVITE_SATS_MAX } from "./ledger.js";
import { publicAppLinks } from "../public-routes.js";
import { inviteToken } from "../auth.js";
import { TASKS_APP } from "../apps/tasks-seed.js";

/** How long an invite's token lets its worker in. */
export const INVITE_TOKEN_DAYS = 90;

/** The URL an invite opens: Tasks' share link with the invite's token as
 *  the page's input (`?input=invite=…`, plans/apps.md §7.1) and the kind of
 *  work it is for (`type=…`, which Tasks opens). `types` is what the token
 *  gives (`inviteToken`); left out, as for an invite made before invites
 *  named their work, every invite-only type Tasks draws. Fixed by the
 *  invite's code, creation time and note, so a listing shows the link the
 *  worker was sent. */
export function invitedAppUrl(base: string, code: string, o: { createdAt?: string | undefined; type?: string | undefined; types?: string[] | undefined } = {}): string {
  const link = publicAppLinks(base, TASKS_APP).link;
  const made = o.createdAt ? Date.parse(o.createdAt) : NaN;
  const token = inviteToken(code, TASKS_APP, (Number.isFinite(made) ? made : Date.now()) + INVITE_TOKEN_DAYS * 86_400_000, o.types);
  const input = new URLSearchParams({ ...(token ? { invite: token } : {}), ...(o.type ? { type: o.type } : {}) }).toString();
  return input ? `${link}&input=${encodeURIComponent(input)}` : link;
}

/** A short link's code: 8 random bytes in base64url (11 characters), so unguessable. */
const SHORT_CODE = /^[A-Za-z0-9_-]{8,32}$/;

/** What strut keeps of an invite (the daemon keeps the rest): the kind of
 *  work it is for, none for open work alone. */
export interface InviteNote {
  type?: string;
  /** The admin who made it (an actor); invites made before this have none. */
  by?: string;
  /** A free label staff gave it (a batch name, "Class A"): invites sharing one are listed together. */
  label?: string;
  /** The code of its short link (`<base>/public/i/<short>`), which redirects to the full join link while the invite is open. */
  short?: string;
}

/** The invites' notes, by code. */
export interface InviteNotes {
  all(): Promise<Record<string, InviteNote>>;
  set(code: string, note: InviteNote): Promise<void>;
}

export function memoryInviteNotes(): InviteNotes {
  const notes: Record<string, InviteNote> = {};
  return {
    all: async () => ({ ...notes }),
    set: async (code, note) => {
      notes[code] = { ...note };
    },
  };
}

/** The notes in one JSON file (`<dataDir>/tasks/invites.json`), written whole
 *  through a temporary file, one write after another. */
export function fileInviteNotes(path: string): InviteNotes {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Record<string, InviteNote>> => {
    const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "{}";
      throw err;
    });
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, InviteNote>) : {};
  };
  return {
    all: () => queue.then(read),
    set(code, note) {
      const next = queue.then(async () => {
        const notes = await read();
        notes[code] = { ...note };
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(notes));
        await rename(tmp, path);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

export type InviteErrorCode =
  | "bad_request"
  | "no_worker_app"
  | "not_online"
  | "no_pay_credential"
  | "no_invites"
  | "unknown_invite"
  | "wallet_unavailable"
  | "wallet_refused";

const STATUS: Record<InviteErrorCode, 400 | 404 | 409 | 501 | 502> = {
  bad_request: 400,
  no_worker_app: 409,
  not_online: 409,
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

/** An invite as staff see it: the daemon's, with `link` the join link and
 *  `type` the kind of work it is for. */
export interface InviteView {
  code: string;
  /** `https://<public view>/public/join#…`, when the daemon gave an invite
   *  and Tasks is in the public view. */
  link?: string;
  sats: number;
  status: InviteStatus;
  createdAt?: string;
  /** The kind of work it opens (and gives, when invite-only); none: open work. */
  type?: string;
  /** When its link stops working: createdAt + INVITE_TOKEN_DAYS. */
  expiresAt?: string;
  /** Who made it (an actor), when known. */
  by?: string;
  /** The label staff gave it (a batch name), when it has one. */
  label?: string;
  /** `<base>/public/i/<code>`: what staff send instead of `link`, which is far too long to send. It redirects to `link`, so it works only while the invite does. */
  shortLink?: string;
  /** The worker who redeemed it, when `status` is `used` because Tasks
   *  granted work by it (an existing Peel account never makes the daemon
   *  say `used`). */
  takenBy?: string;
}

export interface InvitesList {
  invites: InviteView[];
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
  /** The apps in the public view. */
  publicApps(): Promise<string[]>;
  /** The app that draws task type `name`; undefined when there is no such type. */
  typeApp(name: string): Promise<string | undefined>;
  /** What each invite is for. Left out: kept in memory. */
  notes?: InviteNotes;
  /** The worker whose grants came by this invite (the task store's
   *  `grantedBy("invite:"+code)`, the first), if any. Left out: no one. */
  takenBy?(code: string): Promise<string | undefined>;
}

export interface Invites {
  /** A new invite, its link opening Tasks on `type` when given. */
  create(o: { sats?: number; type?: string; label?: string; base: string; by?: string }): Promise<InviteView>;
  /** Every invite the daemon keeps, newest first. */
  list(o: { base: string }): Promise<InvitesList>;
  cancel(code: string): Promise<{ code: string; status: InviteStatus }>;
  /** The full join link a short code stands for, only while its invite is still open and its link valid; undefined otherwise. Reads the daemon, so a cancelled or used invite stops at once. */
  resolveShort(short: string, base: string): Promise<string | undefined>;
}

/** A grant link's code begins so: strut's own, live without the daemon.
 *  Staff make none now (an invite works for someone who has Peel too); the
 *  links already sent keep working. */
export const GRANT_LINK_PREFIX = "link_";

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
  const notes = deps.notes ?? memoryInviteNotes();
  const view = (inv: WalletInvite, base: string, online: boolean, note: InviteNote | undefined): InviteView => {
    // Tasks offline, no link: one that opened nothing after the sign-up would mislead.
    const link =
      inv.link && online
        ? joinLink(base, inv.link, invitedAppUrl(base, inv.code, { createdAt: inv.createdAt, type: note?.type, types: note ? (note.type ? [note.type] : []) : undefined }))
        : undefined;
    return {
      code: inv.code,
      ...(link ? { link } : {}),
      sats: inv.sats,
      status: inv.status,
      ...(inv.createdAt ? { createdAt: inv.createdAt } : {}),
      ...(note?.type ? { type: note.type } : {}),
      ...(Number.isFinite(Date.parse(inv.createdAt ?? "")) ? { expiresAt: new Date(Date.parse(inv.createdAt as string) + INVITE_TOKEN_DAYS * 86_400_000).toISOString() } : {}),
      ...(note?.by ? { by: note.by } : {}),
      ...(note?.label ? { label: note.label } : {}),
      ...(link && note?.short ? { shortLink: `${base.replace(/\/+$/, "")}/public/i/${note.short}` } : {}),
    };
  };
  const tasksOnline = async () => (await deps.publicApps()).includes(TASKS_APP);
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
      const apps = await deps.publicApps();
      if (!apps.includes(TASKS_APP)) {
        throw new InviteError("no_worker_app", `the Tasks page (${TASKS_APP}) is not in the public view: put it online first, so the link has somewhere to open`);
      }
      if (o.type !== undefined) {
        const app = await deps.typeApp(o.type);
        if (!app) throw new InviteError("bad_request", `no task type ${o.type}`);
        if (!apps.includes(app)) throw new InviteError("not_online", `${o.type} is answered in ${app}, which is not in the public view: put it online first`);
      }
      // Before anything is paid: the wallet that can.
      const payer = await payerOf();
      const inv = await payer.invite({ sats }).catch(fromWallet);
      const note: InviteNote = { ...(o.type ? { type: o.type } : {}), ...(o.by ? { by: o.by } : {}), ...(o.label ? { label: o.label } : {}), short: randomBytes(8).toString("base64url") };
      await notes.set(inv.code, note);
      return view(inv, o.base, true, note);
    },

    async list(o) {
      const [online, sats] = await Promise.all([tasksOnline(), deps.inviteSats()]);
      const head = { sats };
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
      const noted = await notes.all();
      // An invite that has made a grant is used, whatever the daemon says: an
      // existing account redeems it in Tasks and the daemon never hears (it
      // marks `used` only for a new sign-up). Only those the daemon still
      // holds as open (or cancelled by strut on that redeem) are read.
      const taken = new Map<string, string>();
      if (deps.takenBy) {
        for (const inv of invites) {
          if (inv.status !== "ready" && inv.status !== "sending" && inv.status !== "cancelled") continue;
          const who = await deps.takenBy(inv.code).catch(() => undefined);
          if (who) taken.set(inv.code, who);
        }
      }
      // Newest first; one with no time keeps the daemon's order, last.
      const sorted = invites.map((inv, i) => ({ inv, i })).sort((a, b) => (b.inv.createdAt ?? "").localeCompare(a.inv.createdAt ?? "") || a.i - b.i);
      return { invites: sorted.map(({ inv }) => {
        const v = view(inv, o.base, online, noted[inv.code]);
        const who = taken.get(inv.code);
        return who ? { ...v, status: "used" as const, takenBy: who } : v;
      }), ...head };
    },

    async resolveShort(short, base) {
      if (!SHORT_CODE.test(short)) return undefined;
      const noted = await notes.all();
      const code = Object.keys(noted).find((k) => noted[k]?.short === short);
      if (!code) return undefined;
      const { invites } = await this.list({ base });
      const inv = invites.find((i) => i.code === code);
      const open = inv && (inv.status === "ready" || inv.status === "sending");
      return open && inv.link && (!inv.expiresAt || Date.parse(inv.expiresAt) > Date.now()) ? inv.link : undefined;
    },

    async cancel(code) {
      if (typeof code !== "string" || !INVITE_CODE.test(code)) throw new InviteError("bad_request", "an invite's code is 1 to 128 letters, digits, - or _");
      const payer = await payerOf();
      return payer.cancelInvite({ code }).catch(fromWallet);
    },
  };
}
