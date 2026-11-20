/**
 * Concept pages whose TEXT COMES FROM GIT (plans/concept-evals.md item e,
 * rulings 5–8). A page is from git when main's node carries a seed or a
 * package stamp (`unique_source_id`, src/concept-seed.ts): strut's own sets
 * (`strut/concepts/`, `strut/concepts/personal/`, and the stakgraph lab's
 * earlier `lab/builder/concepts/` and `lab/job/concepts/`), a package's
 * (`pkg/<publisher>/<name>/`), or a seeder strut does not know. Such a page
 * is NEVER CHANGED AUTOMATICALLY, neither by a merge nor by the dream: the
 * graph would hold one text and git another, and the next seed or install
 * would decide between them.
 *
 * A change to one becomes a PROPOSAL of `knowledge/write-pages`, one per
 * CHECKOUT (pages changed together were measured together), when strut has
 * a checkout it may write the page's file to:
 *   - DEV MODE: strut's own pages, with `STRUT_DEV_CONCEPTS=1` and strut's
 *     pages folder tracked in a git checkout (`npm run dev` runs from
 *     `src/`, so it is the checkout's `src/concepts/`). The person makes the
 *     PR from that checkout with their own git: strut never commits or
 *     pushes there.
 *   - A REPO: a package opened here as a repo (src/packages/repos.ts), its
 *     working copy at `<dataDir>/packages/work/<publisher>/<name>/`. The
 *     repo's Commit then makes the branch and the PR.
 * Anything else is SKIPPED, and the answer says why: strut's pages on a
 * deployed strut (its pages folder is no checkout), a package installed
 * from an index or a `git+` ref that is not opened here, a host's seeder.
 *
 * Accepting the proposal writes each page's file in the form its seeder or
 * install reads (the file it was stamped from; the old `<Name>.md` form kept
 * where the page still fits it, the front matter left as it was where it
 * did not change), then RELOADS the set from there, as a start or an install
 * would: the node takes the file's text and its new stamp. A page removed is
 * a file removed, and its node retired.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphBackend } from "./graph/backend.js";
import { bootEnv } from "./env.js";
import {
  findConcept,
  findConcepts,
  parseConceptFile,
  PERSONAL_CONCEPTS,
  renderConceptPage,
  retireConcepts,
  seedConcepts,
  STRUT_CONCEPTS,
  type ConceptFile,
  type ConceptSet,
} from "./concept-seed.js";
import { buildCard } from "./proposal-card.js";
import { readProposal, proposalsRoot, type NewProposal, type Proposal, type ProposalsCapability } from "./proposals.js";
import { conceptPageFile } from "./packages/build.js";
import { conceptPrefix } from "./packages/installed.js";
import type { Repos } from "./packages/repos.js";
import { findGit } from "./history.js";
import { runProcess } from "./shell.js";
import { dumpYaml, loadYaml as yamlLoad } from "./yaml.js";

/** The flag that lets strut write its own pages into the checkout it runs from. */
export const DEV_CONCEPTS_ENV = "STRUT_DEV_CONCEPTS";
/** The step a change to pages from git is proposed as. */
export const WRITE_PAGES_STEP = "knowledge/write-pages";
/** The checkout name of strut's own pages (dev mode). */
export const STRUT_CHECKOUT = "strut";

/** Where a page's text comes from. */
export interface PageSource {
  name: string;
  /** The set its stamp names, by prefix: `strut/concepts/`,
   *  `strut/concepts/personal/` (the lab's earlier prefixes read as
   *  `strut/concepts/`), `pkg/<publisher>/<name>/`, or the stamp's own
   *  prefix for a seeder strut does not know. */
  set: string;
  /** The file it was stamped from, in that set. */
  file: string;
  /** Where a change to it is written: `strut` (dev mode) or the package
   *  opened here as a repo. Absent: nowhere on this strut. */
  checkout?: string;
  /** Why there is no checkout, when there is none. */
  why?: string;
}

/** One page of a checkout's proposal: as it should be, or removed. */
export interface CheckoutPage {
  name: string;
  set: string;
  file: string;
  /** The page as `parseConceptFile` reads it (the new form); absent: removed. */
  text?: string;
}

/** `knowledge/write-pages`'s input: what a person accepts. */
export interface WritePagesInput {
  checkout: string;
  pages: CheckoutPage[];
  /** What made the change: `merge <branch>`, `dream run <id>`. */
  cause: string;
}

export interface ProposedCheckout {
  checkout: string;
  proposal: string;
  url: string;
  pages: Array<{ name: string; change: "edited" | "removed" }>;
}
export interface SkippedPage {
  name: string;
  change: "edited" | "removed";
  /** `<set><file>`: where its text comes from. */
  source: string;
  why: string;
}

export interface WritePagesResult {
  checkout: string;
  dir: string;
  /** Paths written and removed, under `dir`. */
  written: string[];
  removed: string[];
  /** Each page as the reload left it: its seed action, or `retired`. */
  reloaded: Array<{ name: string; action: string; error?: string }>;
  /** What the person does next. */
  next: string;
}

/** `ctx.services.conceptSources`, which createStrut sets on a graph workspace. */
export interface ConceptSources {
  /** Main's live pages of these names whose text comes from git, by name. */
  fromGit(names: Iterable<string>): Promise<Map<string, PageSource>>;
  /** Main's live page with this ref_id when its text comes from git. */
  fromGitByRef(ref_id: string): Promise<PageSource | null>;
  /** Main's page of this name as a page file would hold it (new form), with its node. */
  pageOf(name: string): Promise<{ ref_id: string; page: ConceptFile; text: string } | null>;
  /** Changes to pages from git: one proposal of `knowledge/write-pages`
   *  per checkout, the rest skipped with why. */
  propose(changes: Array<{ source: PageSource; text?: string }>, o: { by: Proposal["by"]; cause: string }): Promise<{ proposed: ProposedCheckout[]; skipped: SkippedPage[] }>;
  /** The apply of an ACCEPTED `knowledge/write-pages` proposal: the record
   *  on disk is checked for this very input, then the files are written and
   *  the sets reloaded. */
  write(input: WritePagesInput, o: { proposal: string; actor?: string }): Promise<WritePagesResult>;
  /** Is dev mode on: strut's own pages are written to its checkout. */
  readonly dev: boolean;
}

export interface ConceptSourcesDeps {
  /** The backend, unscoped: main is its own namespace. */
  graph: GraphBackend;
  dataDir: string;
  /** Strut's own sets, as this server seeds them (`STRUT_CONCEPTS`,
   *  `PERSONAL_CONCEPTS`): what a stamp is matched against and reloaded. */
  own?: ConceptSet[];
  /** Dev mode (`devConcepts`): the prefixes of strut's sets whose folder is
   *  in a git checkout and may be written. Empty: none. */
  dev?: readonly string[];
  /** The repos opened here (read lazily: they are made after the bag). */
  repos?: () => Pick<Repos, "get" | "isOpen"> | undefined;
  /** Where the proposals go (read lazily). */
  proposals?: () => Pick<ProposalsCapability, "propose"> | undefined;
  /** Told when a reload wrote main's pages. */
  history?: { touch(t: { cause: string; actor?: string }): void; settle(): Promise<void> };
}

/** `<prefix><file>@<hash>` → its prefix (through the last `/`) and file. */
export function parseStamp(stamp: unknown): { prefix: string; file: string } | null {
  if (typeof stamp !== "string") return null;
  const at = stamp.lastIndexOf("@");
  const path = at > 0 ? stamp.slice(0, at) : stamp;
  const cut = path.lastIndexOf("/");
  if (cut < 0 || cut === path.length - 1) return null;
  return { prefix: path.slice(0, cut + 1), file: path.slice(cut + 1) };
}

/** A file a set may hold: one page, `<file>.md`, no folders. */
const FILE = /^[^/\\]+\.md$/i;
const safeFile = (f: string) => FILE.test(f) && f !== ".md" && !f.startsWith("..");

/**
 * Dev mode, decided once at boot: `STRUT_DEV_CONCEPTS=1`, and each of
 * strut's sets whose folder holds pages a git checkout TRACKS (so a build's
 * copy, `build/concepts/`, never is, nor a git dependency's in another
 * project's `node_modules`). The prefixes it may write, or why none.
 */
export async function devConcepts(sets: readonly ConceptSet[], env: NodeJS.ProcessEnv = bootEnv()): Promise<{ sets: string[] } | { off: string }> {
  if (env[DEV_CONCEPTS_ENV] !== "1") return { off: `${DEV_CONCEPTS_ENV} is not 1` };
  const git = await findGit(env);
  if ("missing" in git) return { off: git.missing };
  const out: string[] = [];
  for (const set of sets) {
    const r = await runProcess({ cmd: git.path, args: ["ls-files", "-z", "--", "."], cwd: set.dir, timeoutMs: 10_000 }).catch(() => null);
    if (r?.code === 0 && r.stdout.split("\0").some((f) => FILE.test(f))) out.push(set.prefix);
  }
  return out.length ? { sets: out } : { off: `strut's pages (${sets[0]?.dir ?? "?"}) are not in a git checkout` };
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * A page's new text in the form its file is in (`existing`, the file now):
 * the front matter kept byte for byte where its values did not change (an
 * edit of the docs is a diff of the docs), else written again — the old
 * `<Name>.md` form (`description`, one `parent`) where the file is named by
 * the page and the page still fits it, the new form otherwise.
 */
export function fileText(file: string, page: ConceptFile, existing: string | undefined): string {
  const body = page.docs ? `${page.docs}\n` : "";
  const m = existing !== undefined ? FRONT.exec(existing) : null;
  const was = existing !== undefined ? safeParse(file, existing) : null;
  if (was && was.name === page.name && stable(was.attributes) === stable(page.attributes) && stable([...was.parents].sort()) === stable([...page.parents].sort())) {
    return `${m ? (m[0].endsWith("\n") ? m[0] : `${m[0]}\n`) : ""}${body}`;
  }
  const newForm = !!m && (() => {
    try {
      const meta = yamlLoad(m[1]!);
      return !!meta && typeof meta === "object" && "name" in meta;
    } catch {
      return false;
    }
  })();
  const fitsOld = page.name === file.replace(/\.md$/i, "") && Object.keys(page.attributes).every((k) => k === "description") && page.parents.length <= 1;
  if (!newForm && fitsOld) {
    const front: Record<string, unknown> = {};
    if (typeof page.attributes["description"] === "string") front["description"] = page.attributes["description"];
    if (page.parents[0]) front["parent"] = page.parents[0];
    return `${Object.keys(front).length ? `---\n${dumpYaml(front, { lineWidth: -1 })}---\n` : ""}${body}`;
  }
  return renderConceptPage({ name: page.name, attributes: page.attributes, parents: page.parents, ...(page.docs ? { docs: page.docs } : {}) });
}

const safeParse = (file: string, text: string): ConceptFile | null => {
  try {
    return parseConceptFile(file, text, "");
  } catch {
    return null;
  }
};

/** A stable JSON of a value: keys sorted at every level. */
export const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

export function createConceptSources(deps: ConceptSourcesDeps): ConceptSources {
  const { graph } = deps;
  const own = deps.own ?? [STRUT_CONCEPTS, PERSONAL_CONCEPTS];
  const dev = new Set(deps.dev ?? []);
  const proposalsDir = proposalsRoot(deps.dataDir);

  /** Strut's set a stamp prefix names (its own, or an earlier seeder's). */
  const ownSet = (prefix: string): ConceptSet | undefined => own.find((s) => s.prefix === prefix) ?? own.find((s) => s.legacyPrefixes?.includes(prefix));

  const classify = async (name: string, stamp: unknown): Promise<PageSource | null> => {
    const at = parseStamp(stamp);
    if (!at) return null;
    const set = ownSet(at.prefix);
    if (set) {
      return dev.has(set.prefix)
        ? { name, set: set.prefix, file: at.file, checkout: STRUT_CHECKOUT }
        : {
            name,
            set: set.prefix,
            file: at.file,
            why: `strut's own pages are written only into strut's checkout, in dev mode (${DEV_CONCEPTS_ENV}=1 on a strut run from a git checkout), and this strut is not in it: every start puts back the text strut ships`,
          };
    }
    const pkg = /^pkg\/([^/]+\/[^/]+)\/$/.exec(at.prefix)?.[1];
    if (pkg) {
      const open = await deps.repos?.()?.isOpen(pkg).catch(() => false);
      return open
        ? { name, set: at.prefix, file: at.file, checkout: pkg }
        : { name, set: at.prefix, file: at.file, why: `the package ${pkg} is not opened here as a repo (Packages → Repos), so there is no working copy to write it to` };
    }
    return { name, set: at.prefix, file: at.file, why: `strut has no checkout for the seeder that stamped it` };
  };

  const schemaOf = async () => {
    const schema = await graph.schemas.schema("Concept");
    if (!schema) throw new Error("this graph has no Concept type");
    return schema;
  };

  /** Where a checkout's pages go: each set's folder, or why there is none now. */
  const placeOf = async (checkout: string): Promise<{ dirs: Map<string, string>; sets: (dir: string, prefix: string) => ConceptSet; repo?: boolean } | { refused: string }> => {
    if (checkout === STRUT_CHECKOUT) {
      if (!dev.size) return { refused: `no_checkout: this strut does not write its own pages (dev mode is ${DEV_CONCEPTS_ENV}=1 on a strut run from a git checkout)` };
      const dirs = new Map(own.filter((s) => dev.has(s.prefix)).map((s) => [s.prefix, s.dir]));
      return { dirs, sets: (_dir, prefix) => own.find((s) => s.prefix === prefix)! };
    }
    const repo = await deps.repos?.()?.get(checkout).catch(() => undefined);
    if (!repo) return { refused: `no_checkout: the package ${checkout} is not opened here as a repo (Packages → Repos)` };
    if (repo.conflict?.length || repo.merge) return { refused: `no_checkout: the repo of ${checkout} waits on a merge (${(repo.conflict ?? []).join(", ") || "a pull in progress"}): resolve it and Pull first` };
    const dir = join(repo.workdir, ...(repo.path ? repo.path.split("/") : []), "concepts");
    return { dirs: new Map([[conceptPrefix(checkout), dir]]), sets: (d, prefix) => ({ dir: d, prefix, keepEdited: true, adopt: true }), repo: true };
  };

  const label = (checkout: string) => (checkout === STRUT_CHECKOUT ? "strut's checkout" : `the repo of ${checkout}`);

  return {
    dev: dev.size > 0,

    async fromGit(names) {
      const out = new Map<string, PageSource>();
      const list = [...new Set(names)];
      if (!list.length) return out;
      const found = await findConcepts(graph, await schemaOf(), list);
      for (const [name, node] of found) {
        if (node.deleted) continue;
        const source = await classify(name, node.unique_source_id);
        if (source) out.set(name, source);
      }
      return out;
    },

    async fromGitByRef(ref_id) {
      const d = graph.dialect;
      const [row] = await graph.query(
        `MATCH ${d.node("c", "Concept", { namespace: "$ns" })} WHERE c.ref_id = $r AND ${d.live("c")} RETURN c.name AS name, c.unique_source_id AS usid LIMIT 1`,
        { ns: graph.namespace, r: ref_id },
      );
      return row && typeof row["name"] === "string" ? classify(row["name"], row["usid"]) : null;
    },

    async pageOf(name) {
      const schema = await schemaOf();
      const node = await findConcept(graph, schema, name);
      if (!node || node.deleted) return null;
      const ups = await graph.tx((tx) => graph.edgeEngine.liveEdgesOf(tx, node.ref_id, "PARENT_OF", false));
      const parents: string[] = [];
      for (const e of ups?.edges ?? []) {
        const raw = await graph.tx((tx) => graph.nodeEngine.readRaw(tx, e.other));
        if (raw && typeof raw.props["name"] === "string") parents.push(raw.props["name"]);
      }
      const file = conceptPageFile(schema, node, parents);
      return file ? { ref_id: node.ref_id, page: parseConceptFile(`${file.key}.md`, file.text, ""), text: file.text } : null;
    },

    async propose(changes, o) {
      const proposed: ProposedCheckout[] = [];
      const skipped: SkippedPage[] = [];
      const groups = new Map<string, Array<{ source: PageSource; text?: string }>>();
      for (const c of changes) {
        const change = c.text === undefined ? ("removed" as const) : ("edited" as const);
        if (!c.source.checkout) skipped.push({ name: c.source.name, change, source: `${c.source.set}${c.source.file}`, why: c.source.why ?? "there is no checkout to write it to" });
        else groups.set(c.source.checkout, [...(groups.get(c.source.checkout) ?? []), c]);
      }
      if (!groups.size) return { proposed, skipped };
      const cap = deps.proposals?.();
      if (!cap) {
        for (const list of groups.values()) for (const c of list) skipped.push({ name: c.source.name, change: c.text === undefined ? "removed" : "edited", source: `${c.source.set}${c.source.file}`, why: "this strut server records no proposals" });
        return { proposed, skipped };
      }
      for (const [checkout, list] of groups) {
        const input: WritePagesInput = {
          checkout,
          pages: list.map((c) => ({ name: c.source.name, set: c.source.set, file: c.source.file, ...(c.text !== undefined ? { text: c.text } : {}) })),
          cause: o.cause,
        };
        const names = input.pages.map((p) => `${p.name}${p.text === undefined ? " (removed)" : ""}`);
        const title = `Write ${input.pages.length === 1 ? `the Concept page ${input.pages[0]!.name}` : `${input.pages.length} Concept pages`} into ${label(checkout)}`;
        const summary =
          `${names.join(", ")}: ${input.pages.length === 1 ? "its text comes" : "their text comes"} from git, so ${o.cause} did not change ${input.pages.length === 1 ? "it" : "them"} in the graph. ` +
          `Accepting writes ${input.pages.length === 1 ? "the file" : "the files"} into ${label(checkout)} and reloads ${input.pages.length === 1 ? "it" : "them"} from there; ` +
          (checkout === STRUT_CHECKOUT ? "make the PR from that checkout yourself." : "the repo's Commit then makes the branch and the PR.");
        const card = buildCard({
          input,
          title,
          summary,
          described: {
            fields: [
              { label: "Checkout", value: label(checkout), kind: "ref" },
              { label: "Pages", value: names.join(", ") },
              { label: "Why", value: o.cause },
              ...input.pages.filter((p) => p.text !== undefined).slice(0, 3).map((p) => ({ label: p.name, value: p.text!, kind: "markdown" as const })),
            ],
            actions: { accept: "Write and reload", reject: "Leave them" },
          },
        });
        const rec = await cap.propose({ step: WRITE_PAGES_STEP, input, title, summary, card, approver: "admin", by: o.by } satisfies NewProposal);
        proposed.push({ checkout, proposal: rec.id, url: `/proposals/${encodeURIComponent(rec.id)}`, pages: input.pages.map((p) => ({ name: p.name, change: p.text === undefined ? "removed" : "edited" })) });
      }
      return { proposed, skipped };
    },

    async write(input, o) {
      const rec = await readProposal(proposalsDir, o.proposal);
      if (!rec || rec.step !== WRITE_PAGES_STEP || rec.status !== "accepted" || stable(rec.input) !== stable(input)) {
        throw new Error(
          `write_pages_needs_person: Concept pages are written into a checkout only as the apply of a proposal a person accepted for them` +
            (rec ? ` (proposal ${rec.id} is ${rec.status}, for ${rec.step})` : ""),
        );
      }
      const place = await placeOf(input.checkout);
      if ("refused" in place) throw new Error(place.refused);
      for (const p of input.pages) {
        if (!place.dirs.has(p.set)) throw new Error(`write_pages_refused: ${p.name} is a page of ${p.set}, which ${label(input.checkout)} does not hold`);
        if (!safeFile(p.file)) throw new Error(`write_pages_refused: ${JSON.stringify(p.file)} is not a page's file (<name>.md, no folders)`);
      }
      const written: string[] = [];
      const removed: string[] = [];
      const touched = new Map<string, ConceptSet>();
      const gone: Array<{ set: ConceptSet; name: string; file: string }> = [];
      for (const p of input.pages) {
        const dir = place.dirs.get(p.set)!;
        const set = place.sets(dir, p.set);
        touched.set(p.set, set);
        const at = join(dir, p.file);
        if (p.text === undefined) {
          await rm(at, { force: true });
          removed.push(p.file);
          gone.push({ set, name: p.name, file: p.file });
          continue;
        }
        const page = parseConceptFile(p.file, p.text, p.set);
        if (page.name !== p.name) throw new Error(`write_pages_refused: the text of ${p.name} names the page ${page.name}`);
        const existing = await readFile(at, "utf-8").catch(() => undefined);
        await writeFile(at, fileText(p.file, page, existing), "utf-8");
        written.push(p.file);
      }
      // As a start or an install would: the files are the pages' text now.
      const outcomes = await seedConcepts(graph, [...touched.values()]);
      const ours = new Set(input.pages.map((p) => p.name));
      const reloaded: WritePagesResult["reloaded"] = outcomes.filter((x) => ours.has(x.name)).map((x) => ({ name: x.name, action: x.action, ...(x.error ? { error: x.error } : {}) }));
      if (gone.length) {
        const schema = await schemaOf();
        for (const g of gone) for (const name of await retireConcepts(graph, schema, g.set, [{ name: g.name, file: g.file }])) reloaded.push({ name, action: "retired" });
      }
      deps.history?.touch({ cause: `proposal ${o.proposal}`, ...(o.actor ? { actor: o.actor } : {}) });
      await deps.history?.settle().catch(() => undefined);
      const dir = [...place.dirs.values()][0]!;
      return {
        checkout: input.checkout,
        dir,
        written,
        removed,
        reloaded,
        next: place.repo
          ? `The files are in the working copy of ${input.checkout}: Commit it (Packages → Repos, or package/commit) to make the branch and the pull request.`
          : `The files are in ${dir}: commit them and open the pull request from that checkout with your own git.`,
      };
    },
  };
}
