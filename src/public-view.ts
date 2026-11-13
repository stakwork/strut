/**
 * What adding an item to the PUBLIC VIEW brings along (plans/public-surface.md
 * §2, "The dialog cascades, in the open"; decision 20): the Public view
 * dialog asks before it saves, and pre-checks what the item needs to be
 * read, each line with what it exposes. The record it then saves names
 * everything, so a later release that grants one more workflow never widens
 * the public view by itself.
 *
 * - An APP: the workflows it grants, WITH their runs (the page reads them);
 *   the custom steps those workflows and their subflows run; the app's own
 *   granted reads (§5's `reads`); the Concept roots its workflows read.
 * - A WORKFLOW: its custom steps and its Concept roots; its runs unchecked
 *   (a person opens them on purpose).
 *
 * A workflow names a root with `context/concept { name }`: a literal, or a
 * `{{ params.X }}` read off the flow's own params (the way `closure.ts`
 * reads a `{{ params.tools }}` grant). A name taken from the run's input is
 * chosen per run; it is said, not guessed — the pages a public run did read
 * are visible through the run anyway (§4).
 *
 * The same cascade is `app/make-public`'s (below): an agent ASKS to add an
 * app, an admin says yes on a card that lists these lines, and the door adds
 * what they pre-check (`withNeeds`) through the route's own save.
 */
import { z } from "zod";
import type { CardField, ProposalDescription, StepRegistry } from "./core.js";
import type { WorkspaceStore } from "./workspace.js";
import type { Proposal } from "./proposals.js";
import { flowClosure, globToRegExp, walkSteps } from "./closure.js";
import type { PublicConceptTree, PublicSurface, PublicVisitors } from "./public-surface.js";
import { DEFAULT_SIGN_IN, signInOf, VISITOR_GRAPH_READS, VISITOR_RUN_READS } from "./public-surface.js";

/** One line of the dialog's cascade: what it is, whether it starts checked,
 *  and what adding it shows anyone. */
export interface NeedLine {
  name: string;
  checked: boolean;
  note: string;
}

export interface PublicViewNeeds {
  app?: { name: string; version: string; title: string };
  workflow?: string;
  workflows: Array<NeedLine & { runs: boolean }>;
  steps: NeedLine[];
  reads: NeedLine[];
  concepts: Array<NeedLine & { pages: number; from: string[]; missing?: true }>;
  /** What could not be known before a run: a Concept named by the input. */
  perRun: string[];
}

export interface PublicViewDeps {
  workspace: Pick<WorkspaceStore, "getWorkflow" | "getWorkflowVersion">;
  registry: () => StepRegistry;
  stepSources: () => Record<string, string>;
  /** The app's manifest at the version the public view would serve: the
   *  one named, else the one live now. */
  app?: (name: string, version?: string) => Promise<{ version: string; title: string; grants: { workflows: string[]; steps: string[] } } | null>;
  walk: (roots: string[]) => Promise<PublicConceptTree>;
}

/** Steps whose reads reach a service outside this server, by namespace:
 *  what the dialog says about them. */
const OUTSIDE: Array<[prefix: string, what: string]> = [
  ["sheets/", "Google Sheets"],
  ["gdrive/", "Google Drive"],
  ["github/", "GitHub"],
  ["slack/", "Slack"],
  ["x/", "X"],
];

const RUNS_NOTE = "every run, whole: its input, outputs, agents' transcripts and files";
const DEFINITION_NOTE = "its definition and versions";
const STEP_NOTE = "its schema, its source and the helpers it imports";

function readNote(type: string, custom: boolean): string {
  const out = OUTSIDE.find(([p]) => type.startsWith(p));
  if (out) return `calls ${out[1]} with this server's credentials: anything that account can open, by id, a visitor's page can read`;
  if (custom) return "this server's own code, run with reads only (no graph writes, no shell, no files); it may still call outside services with this server's secrets";
  return "a read of this server";
}

const PARAM_REF = /^\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/** The Concept roots one flow's `context/concept` steps name, and the names
 *  only a run decides. */
function conceptRootsOf(flow: { steps: unknown[]; params?: Record<string, unknown> }): { roots: string[]; perRun: string[] } {
  const roots: string[] = [];
  const perRun: string[] = [];
  walkSteps(flow.steps as never, (s) => {
    if (s.type !== "context/concept") return;
    const name = (s.config as Record<string, unknown> | undefined)?.["name"];
    if (typeof name !== "string" || !name) return;
    if (!name.includes("{{")) return void roots.push(name);
    const ref = name.match(PARAM_REF);
    const v = ref ? flow.params?.[ref[1]!] : undefined;
    if (typeof v === "string" && v && !v.includes("{{")) roots.push(v);
    else perRun.push(name);
  });
  return { roots, perRun };
}

/** What adding `app` (at `version`, else the one live now) or `workflow`
 *  to the public view brings along. */
export async function publicViewNeeds(deps: PublicViewDeps, q: { app?: string; version?: string; workflow?: string }): Promise<PublicViewNeeds | { error: string }> {
  const registry = deps.registry();
  const sources = deps.stepSources();
  const isCustom = (t: string) => sources[t] === "custom";
  const out: PublicViewNeeds = { workflows: [], steps: [], reads: [], concepts: [], perRun: [] };
  let workflows: string[];
  let runs: boolean;
  if (q.app) {
    const app = deps.app ? await deps.app(q.app, q.version) : null;
    if (!app) return { error: `no app "${q.app}"${q.version ? ` at ${q.version}` : ""} on this strut server` };
    out.app = { name: q.app, version: app.version, title: app.title };
    workflows = app.grants.workflows;
    runs = true;
    for (const type of app.grants.steps) {
      // A page reaches runs and the graph through the public view's own
      // rules (§5): nothing to tick for those, nor for a step no visitor
      // may call whatever is ticked.
      // (Launching, a job, a graph write, a paid step: refused to a visitor
      // whatever is ticked, `visitorRefusal`.) Nor for a WORKER's step
      // (`task/*`): a signed-in worker calls it whatever is ticked
      // (`signedInRefusal`), and it is never a read an anonymous visitor makes.
      if (VISITOR_RUN_READS.has(type) || VISITOR_GRAPH_READS.has(type) || /^(?:run|app|job|graph)\//.test(type) || ["llm", "agent", "exec", "acp/prompt"].includes(type)) continue;
      const def = registry[type];
      if (def?.worker) continue;
      const custom = isCustom(type);
      out.reads.push({ name: type, checked: def?.effect === "read", note: def ? readNote(type, custom) : "not a step on this server" });
    }
  } else if (q.workflow) {
    workflows = [q.workflow];
    out.workflow = q.workflow;
    runs = false;
  } else {
    return { error: "name an app (?app=) or a workflow (?workflow=)" };
  }

  const roots = new Map<string, Set<string>>();
  const steps = new Set<string>();
  const seenFlows = new Set<string>();
  for (const name of workflows) {
    let flow;
    try {
      flow = await deps.workspace.getWorkflow(name);
    } catch {
      out.workflows.push({ name, runs, checked: false, note: "not a workflow on this strut server" });
      continue;
    }
    out.workflows.push({ name, runs, checked: true, note: runs ? `${DEFINITION_NOTE}, and ${RUNS_NOTE}` : `${DEFINITION_NOTE} (its runs only if you open them)` });
    const closure = await flowClosure(flow, deps.workspace as never);
    for (const t of closure.types) if (isCustom(t)) steps.add(t);
    for (const g of closure.agentTools) {
      const re = g.includes("*") ? globToRegExp(g) : undefined;
      for (const t of re ? Object.keys(registry).filter((k) => re.test(k)) : [g]) if (isCustom(t)) steps.add(t);
    }
    // The flow and every subflow it reaches, each with its own params.
    const flows = [{ name, flow }];
    for (const child of closure.workflows) {
      try {
        flows.push({ name: child.workflow, flow: child.version ? await deps.workspace.getWorkflowVersion(child.workflow, child.version) : await deps.workspace.getWorkflow(child.workflow) });
      } catch {
        // a subflow that is gone: its roots are unknown
      }
    }
    for (const f of flows) {
      if (seenFlows.has(f.name)) continue;
      seenFlows.add(f.name);
      const found = conceptRootsOf(f.flow as never);
      for (const r of found.roots) (roots.get(r) ?? roots.set(r, new Set()).get(r)!).add(f.name);
      for (const p of found.perRun) out.perRun.push(`${f.name}: a Concept named per run (${p})`);
    }
  }
  out.steps = [...steps].sort().map((t) => ({ name: t, checked: true, note: STEP_NOTE }));
  for (const [root, from] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    const tree = await deps.walk([root]);
    const missing = tree.missing.includes(root);
    out.concepts.push({
      name: root,
      checked: !missing,
      pages: tree.concepts.length,
      from: [...from].sort(),
      note: missing ? "no Concept of that name in this server's graph" : `the root and every page under it (${tree.concepts.length}), live`,
      ...(missing ? { missing: true as const } : {}),
    });
  }
  return out;
}

// ── app/make-public: an agent asks, an admin says yes ───────────────────────
// (plans/public-surface.md §2 "The door", ruled 2026-11-13.) The public view
// is a person's decision. The builder or the orchestrator may ASK to add an
// app to it with `app/make-public`, a proposal only an ADMIN accepts, as
// `app/grant`, `package/install` and `task/set-type` are. The door behind it
// opens only for that accepted record on disk, adds the app the way the
// Public view tab does (the lines `publicViewNeeds` pre-checks, held at the
// version asked) and writes through `PUT /public-view`'s own save. It
// removes nothing and leaves the sign-in as it is.

export const MAKE_PUBLIC_STEP = "app/make-public";

/** The step's input; the gate adds `rationale`. */
export const makePublicInput = z.object({
  name: z.string().min(1).describe("The app's name, as app/publish named it."),
  version: z
    .string()
    .min(1)
    .optional()
    .describe("The version to make public (v3), as app/publish answered it. Left out: the version live when you ask, which the card names and the yes holds."),
});
export type MakePublic = z.infer<typeof makePublicInput>;

/** The record with the cascade's PRE-CHECKED lines merged in: what the
 *  Public view tab saves when the person unticks nothing — the dialog's
 *  `mergeNeeds` over `checkedOf` (web/src/public-view.ts), held equal by its
 *  test. It only adds. */
export function withNeeds(surface: PublicSurface, needs: PublicViewNeeds): PublicSurface {
  const next: PublicSurface = structuredClone(surface);
  if (needs.app) {
    const reads = needs.reads.filter((r) => r.checked).map((r) => r.name);
    const at = next.apps.find((a) => a.name === needs.app!.name);
    if (at) at.reads = [...new Set([...(at.reads ?? []), ...reads])];
    else next.apps.push({ name: needs.app.name, ...(reads.length ? { reads } : {}) });
  }
  if (needs.workflow && !needs.workflows.length) next.workflows.push({ name: needs.workflow });
  for (const w of needs.workflows) {
    if (!w.checked) continue;
    const at = next.workflows.find((x) => x.name === w.name);
    if (at) at.runs = at.runs || w.runs || undefined;
    else next.workflows.push({ name: w.name, ...(w.runs ? { runs: true } : {}) });
  }
  for (const s of needs.steps) if (s.checked && !next.steps.includes(s.name)) next.steps.push(s.name);
  for (const c of needs.concepts) if (c.checked && !next.concepts.includes(c.name)) next.concepts.push(c.name);
  for (const w of next.workflows) if (!w.runs) delete w.runs;
  return next;
}

/** What the card reads at proposal time (`PublicViewCapability.plan`). */
export interface MakePublicPlan {
  /** The cascade at the version asked, as `GET /public-view/needs` answers it. */
  needs: PublicViewNeeds | { error: string };
  /** The version the yes holds: the one asked, else the one live now. */
  version?: string;
  /** The version people open now, and whether a release holds it. */
  live?: { version: string; held: boolean };
  /** Strut seeds the app: it always runs its committed version, never held. */
  seeded?: boolean;
  /** The app is in the public view already. */
  listed: boolean;
  /** The view's sign-in, unchanged: its own (`set`), else the default. */
  visitors: { signIn: PublicVisitors["signIn"]; visitorKey?: "domain"; set: boolean };
  /** A served box's package: its serve.yaml writes the public view. */
  served?: string;
}

/** What a yes did. */
export interface MadePublic {
  app: string;
  version: string;
  /** What the cascade added, by kind (a line already there is not named). */
  added: { workflows: string[]; steps: string[]; reads: string[]; concepts: string[] };
  /** Who may sign in now. */
  signIn: PublicVisitors["signIn"];
}

/** `ctx.services.publicView`: the card's read and `app/make-public`'s door. */
export interface PublicViewCapability {
  plan(name: string, version?: string): Promise<MakePublicPlan>;
  /** Adds the app at `version` with its cascade — only as the apply of an
   *  ACCEPTED `app/make-public` proposal on disk (an admin's) for that app
   *  and version. */
  addApp(name: string, version: string, o: { proposal: string; actor?: string }): Promise<MadePublic>;
}

/** The save `PUT /public-view` writes through (createStrut): its checks,
 *  the record, and the hold — `holdAt` holds an app at that version, or
 *  refuses the whole save. Answered as the route answers. */
export type PublicViewSave = (body: unknown, o: { actor?: string; holdAt?: Record<string, string> }) => Promise<{ status: number; body: { error?: string; surface?: PublicSurface } & Record<string, unknown> }>;

export interface PublicViewDoorDeps {
  needs(app: string, version?: string): Promise<PublicViewNeeds | { error: string }>;
  view(): Promise<PublicSurface>;
  /** The app as people open it now, and whether `version` is a seed. */
  app(name: string, version?: string): Promise<{ version: string; held: boolean; seeded: boolean } | null>;
  /** The package a served box serves, or undefined. */
  served(): string | undefined;
  /** A proposal's record on disk, or null. */
  proposal(id: string): Promise<Proposal | null>;
  save: PublicViewSave;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createPublicViewDoor(deps: PublicViewDoorDeps): PublicViewCapability {
  return {
    async plan(name, version) {
      const [app, view] = await Promise.all([deps.app(name, version).catch(() => null), deps.view()]);
      const at = version ?? app?.version;
      const needs = await deps.needs(name, at);
      const served = deps.served();
      return {
        needs,
        ...(at ? { version: at } : {}),
        ...(app ? { live: { version: app.version, held: app.held } } : {}),
        ...(app?.seeded ? { seeded: true } : {}),
        listed: view.apps.some((a) => a.name === name),
        visitors: view.visitors
          ? { signIn: view.visitors.signIn, ...(view.visitors.visitorKey === "domain" ? { visitorKey: "domain" as const } : {}), set: true }
          : { signIn: [...DEFAULT_SIGN_IN], set: false },
        ...(served ? { served } : {}),
      };
    },

    async addApp(name, version, o) {
      // The door: an ACCEPTED proposal of this very step, only an admin's to
      // accept, for this app and this version — the admin's edits merged as
      // the decision merged them, parsed as the step parses them.
      const rec = typeof o?.proposal === "string" ? await deps.proposal(o.proposal) : null;
      const asked = rec ? { ...(isRecord(rec.input) ? rec.input : {}), ...(isRecord(rec.decision?.input) ? rec.decision.input : {}) } : {};
      const parsed = makePublicInput.safeParse(asked);
      if (!rec || rec.step !== MAKE_PUBLIC_STEP || rec.status !== "accepted" || rec.approver !== "admin" || !parsed.success || parsed.data.name !== name || parsed.data.version !== version) {
        throw new Error(
          `make_public_needs_admin: adding the app ${name} to the public view runs only as the apply of a proposal an admin accepted for it at ${version}` +
            (rec ? ` (proposal ${rec.id} is ${rec.status}, for ${rec.step}${typeof asked["name"] === "string" ? ` ${asked["name"]}${typeof asked["version"] === "string" ? ` ${asked["version"]}` : ""}` : ""})` : ""),
        );
      }
      const needs = await deps.needs(name, version);
      if ("error" in needs) throw new Error(`make_public: ${needs.error}`);
      const before = await deps.view();
      const next = withNeeds(before, needs);
      const by = rec.decision?.by ?? o.actor;
      const out = await deps.save(next, { holdAt: { [name]: version }, ...(by ? { actor: by } : {}) });
      if (out.status !== 200 || !out.body.surface) throw new Error(out.body.error ?? `the public view was not saved (${out.status})`);
      const saved = out.body.surface;
      const was = (list: string[], n: string) => list.includes(n);
      const app = before.apps.find((a) => a.name === name);
      return {
        app: name,
        version,
        added: {
          workflows: needs.workflows.filter((w) => w.checked && !before.workflows.some((x) => x.name === w.name && (x.runs || !w.runs))).map((w) => w.name),
          steps: needs.steps.filter((s) => s.checked && !was(before.steps, s.name)).map((s) => s.name),
          reads: needs.reads.filter((r) => r.checked && !was(app?.reads ?? [], r.name)).map((r) => r.name),
          concepts: needs.concepts.filter((c) => c.checked && !was(before.concepts, c.name)).map((c) => c.name),
        },
        signIn: signInOf(saved),
      };
    },
  };
}

// ── the card ────────────────────────────────────────────────────────────────

/** A sign-in method as the Public view tab names it (web/src/public-view.ts
 *  `SIGN_IN_METHODS`). */
const SIGN_IN_WORDS: Record<string, string> = {
  sphinx: "their Sphinx account, through the wallet that holds it (Peel)",
  key: "this browser's key",
  lnurl: "a Lightning wallet (LNURL-auth)",
  nostr: "a Nostr extension",
  ticket: "a host's ticket",
};
const SIGN_IN_SHORT: Record<string, string> = { sphinx: "Sphinx", key: "a browser key", lnurl: "a Lightning wallet", nostr: "Nostr", ticket: "a host's ticket" };

/** One cascade line as the dialog shows it: its name and what it exposes;
 *  one it does not pre-check is said and not added. */
export function needLine(l: NeedLine): string {
  return l.checked ? `${l.name} — ${l.note}` : `${l.name} — not added: ${l.note}`;
}

/**
 * The card (`app/make-public`'s `describe`): the app and its version, what
 * anyone will see — each line of the cascade with what it exposes, as the
 * Public view tab shows it — who can sign in, and that the app is held at
 * this version. Runs anyone reads whole and a read that reaches an outside
 * service with this server's credentials are dangers; so is anything that
 * makes the yes fail. `input` pins the version.
 */
export function makePublicCard(cfg: MakePublic, plan: MakePublicPlan | undefined): ProposalDescription {
  const actions = { accept: "Make public", reject: "Don't" };
  if (!plan) return { title: `Make the app ${cfg.name} public`, actions };
  const { needs, version, live } = plan;
  const fails: string[] = [];
  if (plan.served) fails.push(`this strut server serves ${plan.served}, whose serve.yaml writes the public view at every deploy`);
  if ("error" in needs) {
    fails.push(needs.error);
    return {
      title: `Make the app ${cfg.name} public`,
      summary: `Accepting it fails: ${fails.join("; ")}.`,
      fields: [{ label: "App", value: `${cfg.name}${cfg.version ? ` ${cfg.version}` : ""} — ${needs.error}`, danger: true }],
      actions,
      full: true,
    };
  }
  const app = needs.app!;
  const v = version ?? app.version;
  if (plan.seeded) fails.push(`strut seeds ${cfg.name}: it always runs the version strut ships and cannot be held at one`);

  const fields: CardField[] = [{ label: "App", value: `${app.title} — ${app.name} ${v}` }];
  const moves = !!live && live.version !== v;
  fields.push({
    label: "Held at",
    value: plan.seeded
      ? "not held: strut seeds this app"
      : `${v}: a later publish is a draft until someone makes it live` +
        (moves ? `. Its live version moves from ${live!.version} to ${v}, for everyone who opens it` : live?.held ? " (already held there)" : ""),
    ...(moves || plan.seeded ? { danger: true } : {}),
  });
  const section = <L extends NeedLine>(label: string, lines: L[], danger: (l: L) => boolean) => {
    if (!lines.length) return;
    const d = lines.some((l) => l.checked && danger(l));
    fields.push({ label, value: lines.map(needLine).join("\n"), ...(d ? { danger: true } : {}) });
  };
  section("Workflows", needs.workflows, (w) => w.runs);
  section("Reads the page may call", needs.reads, (r) => r.note.startsWith("calls "));
  section("Steps", needs.steps, () => false);
  if (needs.concepts.length) {
    fields.push({ label: "Concept trees", value: needs.concepts.map((c) => `${needLine(c)} (read by ${c.from.join(", ")})`).join("\n") });
  }
  if (needs.perRun.length) fields.push({ label: "Decided per run, not added", value: needs.perRun.join("\n") });

  const vis = plan.visitors;
  const nobody = !vis.signIn.length;
  const how = vis.signIn.map((m) => SIGN_IN_WORDS[m] ?? m).join("; ");
  const key = vis.visitorKey === "domain" ? "a key per domain, so a visitor is someone new on each domain" : "the root key, so a visitor is one person on every app here";
  fields.push({
    label: "Who can sign in",
    value: nobody
      ? "nobody: the public view offers no sign-in, so every visitor is anonymous and no worker can sign in. A person changes that in Publish → Public view."
      : `${how}, with ${key}. ${vis.set ? "The public view's own setting, unchanged." : "The default; a person changes it in Publish → Public view."} Anyone else sees the page signed out.`,
    ...(nobody ? { danger: true } : {}),
  });

  const lines: string[] = [];
  lines.push(`Anyone with the link can open ${app.title} (${app.name} ${v}) and read what is listed here.`);
  if (plan.listed) lines.push("It is in the public view already: only what it needs now and is not there yet is added.");
  lines.push(nobody ? "Nobody can sign in to it." : `Visitors sign in with ${vis.signIn.map((m) => SIGN_IN_SHORT[m] ?? m).join(", ")}.`);
  if (!plan.seeded) lines.push(`It is held at ${v}: later edits are drafts until someone makes them live.`);
  lines.push("Nothing else in the public view changes, and nothing is taken out of it.");
  if (fails.length) lines.push(`Accepting it fails: ${fails.join("; ")}.`);
  return {
    title: `Make the app ${app.title} public`,
    summary: lines.join(" "),
    fields,
    actions,
    full: true,
    input: { name: cfg.name, version: v },
  };
}
