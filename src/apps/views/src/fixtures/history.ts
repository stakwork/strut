// A strut's HISTORY for the gallery (plans/concept-history.md): a legal
// practice's Concept tree over six commits — written at boot, its NDA page
// edited by a run, a page added and another moved, a page renamed (git sees
// the rename) and a short one renamed and rewritten (git sees a delete and an
// add; ConceptDiff pairs them), one removed — answered as `history/read`
// answers, and three proposals that would change it, as `proposal/get`.
import type { ConceptPage } from "@strut/kit";

const P = (name: string, parents: string[], description: string, docs?: string): ConceptPage => ({
  name,
  attributes: { description },
  parents,
  ...(docs ? { docs } : {}),
});

const key = (name: string) => `concepts/concept-${name.replace(/ /g, "").toLowerCase().replace(/[^a-z0-9]/g, "")}.md`;

const NDA_DOCS_1 = `# Non-disclosure agreements

Read the definition of Confidential Information first.

## What to check

- Who is bound: one side or both.
- How long the duty lasts.
- What may be shared with advisers.

## Red flags

- No carve-out for information already public.
- Residuals clauses.`;

const NDA_DOCS_2 = `# Non-disclosure agreements

Read the definition of Confidential Information first: it decides everything else.

## What to check

- Who is bound: one side or both.
- How long the duty lasts — two to five years is market.
- What may be shared with advisers.
- Whether the agreement survives termination.

## Red flags

- No carve-out for information already public.
- Residuals clauses.
- A non-solicit hidden in the confidentiality section.`;

interface Commit {
  id: string;
  time: string;
  author: string;
  subject: string;
  runs: string[];
  pages: Record<string, ConceptPage>;
  /** Files git paired as renamed in this commit: new path → old. */
  renames?: Record<string, string>;
}

const base: Record<string, ConceptPage> = {
  [key("Law")]: P("Law", [], "Everything the firm knows about practising law."),
  [key("Contracts")]: P("Contracts", ["Law"], "Agreements: how to read, review and negotiate them."),
  [key("NDA")]: P("NDA", ["Contracts"], "Non-disclosure agreements.", NDA_DOCS_1),
  [key("SLA")]: P("SLA", ["Contracts"], "Uptime promises in service contracts and the credits they owe."),
  [key("Torts")]: P("Torts", ["Law"], "Civil wrongs: negligence, nuisance, defamation and the duties behind them.", "# Torts\n\nStart from the duty of care.\n\nThen breach, causation, loss."),
  [key("Escrow")]: P("Escrow", ["Contracts"], "Source-code escrow for licensed software."),
};

const day = (h: number) => new Date(Date.UTC(2026, 10, 8, h, 12)).toISOString();

const c2 = { ...base, [key("NDA")]: P("NDA", ["Contracts"], "Non-disclosure agreements: what each side may share, with whom, and for how long.", NDA_DOCS_2) };
const c3 = {
  ...c2,
  [key("Wills")]: P("Wills", ["Law"], "Last wills and testaments: capacity, witnesses, revocation."),
  [key("Services")]: P("Services", ["Law"], "Service agreements."),
  [key("SLA")]: P("SLA", ["Contracts", "Services"], "Uptime promises in service contracts and the credits they owe."),
};
const { [key("Torts")]: _torts, [key("SLA")]: _sla, ...c4rest } = c3;
const c4 = {
  ...c4rest,
  [key("Tort Law")]: P("Tort Law", ["Law"], "Civil wrongs: negligence, nuisance, defamation and the duties behind them.", "# Torts\n\nStart from the duty of care.\n\nThen breach, causation, loss."),
  [key("Service levels")]: P("Service levels", ["Contracts", "Services"], "Uptime promises in service agreements, and the credits owed when missed."),
};
const { [key("Escrow")]: _escrow, ...c5 } = c4;

/** Oldest first. */
export const HISTORY_COMMITS: Commit[] = [
  { id: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", time: day(1), author: "strut", subject: "boot", runs: [], pages: base },
  { id: "b2c3d4e5f60718293a4b5c6d7e8f901234567891", time: day(6), author: "ada-7f3c", subject: "run 1790000000700", runs: ["1790000000700"], pages: c2 },
  { id: "c3d4e5f60718293a4b5c6d7e8f9012345678912a", time: day(9), author: "ada-7f3c", subject: "run 1790000000800", runs: ["1790000000800"], pages: c3 },
  {
    id: "d4e5f60718293a4b5c6d7e8f9012345678912ab3",
    time: day(14),
    author: "ben-21aa",
    subject: "run 1790000000900",
    runs: ["1790000000900"],
    pages: c4,
    renames: { [key("Tort Law")]: key("Torts") },
  },
  { id: "e5f60718293a4b5c6d7e8f9012345678912ab3c4", time: day(17), author: "ada-7f3c", subject: "proposal 3f9c2a", runs: [], pages: c5 },
];

/** The moments the gallery opens on. */
export const HISTORY_FROM = HISTORY_COMMITS[0]!.id;
export const HISTORY_TO = "main";

/** The live tree's parents by name (what an app holds), for ConceptDiff's context rows. */
export const LIVE_PARENTS: Record<string, string[]> = Object.fromEntries(Object.values(c5).map((p) => [p.name, p.parents]));

const text = (p: ConceptPage) =>
  `---\nname: ${p.name}\ndescription: ${String(p.attributes["description"] ?? "")}\nparents:\n${p.parents.map((x) => `  - ${x}`).join("\n")}\n---\n${p.docs ?? ""}\n`;

function commitAt(at: string | undefined): Commit | null {
  if (!at || at === "main" || at === "HEAD") return HISTORY_COMMITS[HISTORY_COMMITS.length - 1]!;
  const byId = HISTORY_COMMITS.find((c) => c.id.startsWith(at));
  if (byId) return byId;
  const ms = /^\d+$/.test(at) ? Number(at) : Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`history/read: ${at} is neither a commit nor a time`);
  return [...HISTORY_COMMITS].reverse().find((c) => Date.parse(c.time) <= ms) ?? null;
}

type Change = { path: string; status: "added" | "modified" | "deleted" | "renamed"; from?: string };

function changesBetween(a: Record<string, ConceptPage>, b: Record<string, ConceptPage>, renames: Record<string, string> = {}): Change[] {
  const out: Change[] = [];
  const renamedFrom = new Set(Object.values(renames));
  for (const [path, page] of Object.entries(b)) {
    if (renames[path] && a[renames[path]!]) out.push({ path, status: "renamed", from: renames[path] });
    else if (!a[path]) out.push({ path, status: "added" });
    else if (JSON.stringify(a[path]) !== JSON.stringify(page)) out.push({ path, status: "modified" });
  }
  for (const path of Object.keys(a)) if (!b[path] && !renamedFrom.has(path)) out.push({ path, status: "deleted" });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

/** `history/read`, over the fixture's commits. */
export function historyFixture(c: Record<string, unknown>): unknown {
  const action = c["action"];
  if (action === "show") {
    const at = commitAt(String(c["at"]));
    const page = at?.pages[String(c["path"])];
    if (!at || !page) throw new Error(`history/read: no ${String(c["path"])} at ${String(c["at"]).slice(0, 12)}`);
    return { path: c["path"], at: at.id, time: at.time, kind: "file", text: text(page), parsed: page };
  }
  if (action === "diff") {
    const from = commitAt(String(c["from"]));
    const to = commitAt(String(c["to"]))!;
    const i = from ? HISTORY_COMMITS.indexOf(from) : -1;
    const j = HISTORY_COMMITS.indexOf(to);
    // A rename the commits in between declared, when both ends of it are in the range.
    const renames = Object.assign({}, ...HISTORY_COMMITS.slice(i + 1, j + 1).map((x) => x.renames ?? {}));
    const before = from?.pages ?? {};
    const entries = changesBetween(before, to.pages, renames).map((ch) => {
      const old = before[ch.from ?? ch.path];
      const now = to.pages[ch.path];
      return { ...ch, ...(old && ch.status !== "added" ? { before: { text: text(old), parsed: old } } : {}), ...(now && ch.status !== "deleted" ? { after: { text: text(now), parsed: now } } : {}) };
    });
    return { from: from?.id ?? null, to: to.id, entries };
  }
  if (action === "log") {
    const limit = Number(c["limit"] ?? 50);
    let path = typeof c["path"] === "string" ? c["path"] : undefined;
    const commits: Array<Omit<Commit, "pages" | "renames"> & { changes: Change[] }> = [];
    for (let k = HISTORY_COMMITS.length - 1; k >= 0; k--) {
      const cur = HISTORY_COMMITS[k]!;
      const changes = changesBetween(HISTORY_COMMITS[k - 1]?.pages ?? {}, cur.pages, cur.renames);
      const mine = path ? changes.filter((ch) => ch.path === path || (path!.startsWith("concepts") && !path!.endsWith(".md"))) : changes;
      if (!mine.length) continue;
      const { pages: _p, renames: _r, ...head } = cur;
      commits.push({ ...head, changes: mine });
      const followed = path?.endsWith(".md") ? mine.find((ch) => ch.path === path) : undefined;
      if (followed?.from) path = followed.from;
    }
    return { commits: commits.slice(0, limit), ...(commits.length > limit ? { more: true } : {}) };
  }
  return { commit: null, changed: false };
}

/** The nodes the proposals name, as `graph/graph-get-batched` gives them. */
const NODES: Record<string, { name: string; node_type: string }> = {
  "hist-nda": { name: "NDA", node_type: "Concept" },
  "hist-contracts": { name: "Contracts", node_type: "Concept" },
  "hist-services": { name: "Services", node_type: "Concept" },
  "hist-service-levels": { name: "Service levels", node_type: "Concept" },
};

export function historyNode(refId: string) {
  const n = NODES[refId];
  return n ? { ref_id: refId, node_type: n.node_type, name: n.name, properties: { name: n.name }, edges: [] } : undefined;
}

export const PROPOSALS: Record<string, { label: string; record: Record<string, unknown> }> = {
  "prop-edit": {
    label: "Edit NDA",
    record: {
      id: "prop-edit",
      step: "graph/edit-node",
      title: "Tighten the NDA page",
      status: "pending",
      rationale: "Three reviews this week missed a mutual-NDA clause; the page should say to check it first.",
      input: {
        ref_id: "hist-nda",
        node_data: {
          description: "Non-disclosure agreements, mutual or one-way: what each side may share, with whom, and for how long.",
          docs: NDA_DOCS_2.replace("- Who is bound: one side or both.", "- Who is bound: one side or both — check this first.").replace("- Residuals clauses.", "- Residuals clauses, or a feedback licence."),
        },
      },
    },
  },
  "prop-move": {
    label: "Move Service levels",
    record: {
      id: "prop-move",
      step: "graph/move-node",
      title: "Service levels belong under Services alone",
      status: "pending",
      input: { ref_id: "hist-service-levels", edge_type: "PARENT_OF", direction: "reverse", from_ref_id: "hist-contracts", to_ref_id: "hist-services" },
    },
  },
  "prop-create": {
    label: "Add Arbitration",
    record: {
      id: "prop-create",
      step: "graph/create-node",
      title: "A page for arbitration clauses",
      status: "pending",
      input: { node_type: "Concept", node_data: { name: "Arbitration", description: "Arbitration clauses: seat, rules, the number of arbitrators.", docs: "# Arbitration\n\nCheck the seat first." } },
    },
  },
};
