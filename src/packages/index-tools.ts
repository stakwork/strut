/**
 * The index's own MCP door (`POST /index/mcp`; plans/marketplace.md §7, the
 * store front): three READ tools over a `PackageIndex`, served to anyone
 * with no credential — like the `/index/*` reads the store page is drawn
 * from — so any MCP-capable agent adds the store with one line:
 *
 *   claude mcp add --transport http strut-store https://<index>/index/mcp
 *
 *   search_packages  what people published, each hit with what its release
 *                    holds (the archive as the index read it)
 *   get_package      one package's page: apps, workflows with their inputs,
 *                    steps, Concept pages, the README, the secrets, `can`
 *   get_concept      the Concept tree the packages carry, or one page
 *
 * And `GET /llms.txt` at the index's root (`llmsTxt`, llmstxt.org): the
 * same store as ONE markdown page for an agent that fetches URLs rather
 * than speaks MCP — what the index is, the door above, the open JSON
 * reads, every listed package with what it holds, every Concept page —
 * each a link to its JSON page, so the agent reads on without a browser.
 *
 * Nothing installs: the index holds no strut to install into, and an
 * install is a person's act on their own strut (§8). The tools say so, and
 * where: the store's Install link, which opens the person's Packages
 * dialog on the name. Everything is derived (the crawl's reading of the
 * publishers' catalogs and archives) and an install re-verifies against the
 * publisher — the instructions say that too. Adapted by src/ai/mcp.ts like
 * any AI SDK ToolSet; results capped where they are made.
 */
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { capToolResults } from "../ai/tools.js";
import type { PackageIndex } from "./index.js";
import { INSTALL_IS_A_PERSONS_ACT, README_BRIEF_CHARS, briefPackagePage } from "./indexes.js";

export interface IndexToolsOptions {
  /** The store front's base URL (the index strut's, when it serves the UI):
   *  each result links its page there. None → no links. */
  store?: string;
}

/** The store's links for a package and a Concept page (web/src/store-links.ts). */
const storeLinks = (store: string | undefined) => ({
  package: (name: string) => (store ? { store: `${store}/?store=1&pkg=${encodeURIComponent(name)}` } : {}),
  concept: (name: string) => (store ? { store: `${store}/?store=1&concept=${encodeURIComponent(name)}` } : {}),
  browse: (q: string) => (store ? { store: `${store}/?store=1${q ? `&q=${encodeURIComponent(q)}` : ""}` } : {}),
});

const CAN =
  "`can: { spends, acts, code }` says whether running it reaches a model call (spends money), a step that acts on the world (effect: write), or code (exec, or the package's own TypeScript) — a READING off the files, never a check: an install re-reads everything through the real parsers and re-verifies the package against its publisher's signed catalog.";

export function buildIndexTools(index: PackageIndex, opts: IndexToolsOptions = {}): ToolSet {
  const links = storeLinks(opts.store);
  const tools: ToolSet = {
    search_packages: tool({
      description:
        "Search this package index — the store of PACKAGES people published for strut, the workflow engine: workflows (automations), steps, apps (front ends over workflows) and Concept pages (knowledge). Every word of `query` must match a package's name, description or publisher; empty lists everything (up to `limit`). " +
        "Each hit: { package, publisher, key, urls, version, digest, description?, license?, requires?, detail? } — `detail` is what the newest release HOLDS, read off its archive: `apps` (each with its title and `can`), the counts of `workflows`, `steps` and `concepts`, the `secrets` it needs, `can`, and whether it has a `readme` (absent until the index has read the archive). get_package reads one package's whole page. " +
        CAN +
        " " +
        INSTALL_IS_A_PERSONS_ACT,
      inputSchema: z.object({
        query: z.string().default("").describe("Words to match, e.g. \"linear issues\"; empty lists everything."),
        limit: z.number().int().min(1).max(200).default(30),
      }),
      execute: async ({ query, limit }) => {
        const packages = await index.search(query, limit);
        return { packages, total: packages.length, ...links.browse(query), install: INSTALL_IS_A_PERSONS_ACT };
      },
    }),

    get_package: tool({
      description:
        "One package's PAGE: { package, publisher, key, urls, description?, releases (newest first, yanked kept), channels, readAt, detail?, detailError?, store? }. `detail` is the newest release read off its archive — `apps` (title, grants, `can`), `workflows` (each with its `inputs`, the step types it runs, its `grants`, `secrets`, `can`, `claims`), `steps` (effect, the secrets they read, the lint's findings), `concepts` (name, description, parent — a page's docs through get_concept), the README (cut at " +
        `${README_BRIEF_CHARS} chars), the \`secrets\` the whole package needs, and \`can\`. \`detailError\` says why there is no detail yet (the archive not read, or unreadable). ` +
        CAN +
        " " +
        INSTALL_IS_A_PERSONS_ACT,
      inputSchema: z.object({
        package: z.string().describe("The package name, publisher/name (a hit's `package`)."),
      }),
      execute: async ({ package: name }) => {
        const page = await index.package(name);
        if (!page) return { error: `no listed publisher's catalog has ${name} — search_packages lists what this index knows` };
        return { ...briefPackagePage(page), ...links.package(name), install: INSTALL_IS_A_PERSONS_ACT };
      },
    }),

    get_concept: tool({
      description:
        "The CONCEPT TREE the listed packages carry — knowledge pages (`concepts/<Name>.md`: a description, a parent, docs), folded across every package into one tree. " +
        "With no `name`: the entries, each { name, description?, parent?, packages: [{ package, version }] } — every word of `query` must match a name or description; empty lists the whole tree. " +
        "With `name`: that page — the entry plus `docs` (the first package's text), `children` (the pages naming it as parent) and `parents` (nearest first) — or { error } when no listed package carries it. " +
        "Use it to find which package teaches a subject; get_package reads the package. " +
        INSTALL_IS_A_PERSONS_ACT,
      inputSchema: z.object({
        name: z.string().optional().describe("A Concept page's exact name, for its docs, children and parents."),
        query: z.string().optional().describe("Words to match in a page's name or description; omit for the whole tree."),
      }),
      execute: async ({ name, query }) => {
        if (name) {
          const page = await index.concept(name);
          if (!page) return { error: `no listed package carries a Concept page named "${name}" — get_concept with no name lists the tree` };
          return { ...page, ...links.concept(name) };
        }
        const concepts = await index.concepts(query ?? "");
        return { concepts, total: concepts.length };
      },
    }),
  };
  return capToolResults(tools);
}

const plural = (n: number, word: string) => (n === 0 ? "" : `${n} ${word}${n === 1 ? "" : "s"}`);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const canWords = (can: { spends: boolean; acts: boolean; code: boolean }) =>
  [can.spends && "spends (model calls)", can.acts && "acts on the world", can.code && "runs code"].filter(Boolean).join(", ");

/** `GET /llms.txt` on an index strut (llmstxt.org): the store as one
 *  markdown page for an agent that fetches URLs. An H1, a blockquote
 *  saying what this is, how an agent reaches it (the MCP door, the open
 *  reads), then `## Reads`, `## Packages` (every listed package at its
 *  newest release, with what its archive holds), `## Concepts` (every page
 *  the packages carry) and `## Optional` (the store page for a person) —
 *  each entry `- [name](url): notes`, the url its JSON page here. Derived
 *  like everything on the index; nothing on it installs. */
export async function llmsTxt(index: PackageIndex, opts: { publicUrl: string; store?: string }): Promise<string> {
  const base = opts.publicUrl.replace(/\/+$/, "");
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();
  const [info, packages, concepts] = await Promise.all([index.info(), index.search("", 500), index.concepts("")]);
  const out: string[] = [
    `# strut package index at ${host}`,
    "",
    `> The store of PACKAGES people published for strut, the workflow engine: workflows (automations), steps, apps (front ends over workflows) and Concept pages (knowledge), each pinned by its digest. This index is the phone book — it lists publishers by the public key that signs each one's catalog and follows every listed catalog. Everything here is DERIVED and unsigned past the index card: a reading of the publishers' catalogs and archives as this index crawled them, never a check — an install re-verifies the package against its publisher's own signed catalog and re-reads its files through the real parsers.`,
    "",
    `For an agent: this index is an MCP server — \`claude mcp add --transport http strut-store ${base}/index/mcp\` gives you search_packages, get_package and get_concept with no credential. The same reads are plain JSON, open to anyone, under Reads below; every package and Concept link on this page is one of them.`,
    "",
    INSTALL_IS_A_PERSONS_ACT,
    "",
    "## Reads",
    "",
    `- [Search](${base}/index/packages?q=): every listed package at its newest release, \`{ packages: [{ package, publisher, key, urls, version, digest, description?, license?, requires?, detail? }] }\`; every word of \`q\` must match the name, description or publisher, empty lists all (\`limit\`, 100). \`detail\` is what the archive holds: the apps, counts of workflows, steps and Concept pages, the secrets it needs, \`can\`, whether it has a README`,
    `- [A package's page](${base}/index/packages/{publisher}/{name}): its releases and channels, and \`detail\` — apps (title, grants, \`can\`), workflows (inputs, the step types they run, grants, secrets, claims), steps (effect, the secrets they read, lint findings), Concept pages, the README, the secrets the whole package needs, and \`can: { spends, acts, code }\`: whether running it reaches a model call, a step that acts on the world, or code`,
    `- [The Concept tree](${base}/index/concepts?q=): the knowledge pages the packages carry, folded into one tree, \`{ concepts: [{ name, description?, parent?, packages }] }\`; one page with its docs, children and parents at ${base}/index/concepts/{name}`,
    `- [The index card](${base}/index/catalog): the signed list of publishers (Ed25519 over RFC 8785 JSON, \`strut-index\`), what a strut follows${info ? ` — key ${info.key}` : ""}`,
    `- [MCP](${base}/index/mcp): POST, JSON-RPC over HTTP, stateless, no credential — the three tools above`,
    "",
    "## Packages",
    "",
  ];
  if (packages.length === 0) out.push("No package is listed yet.");
  for (const h of packages) {
    const facts: string[] = [h.version];
    const d = h.detail;
    if (d) {
      const counts = [plural(d.workflows, "workflow"), plural(d.steps, "step"), plural(d.apps.length, "app"), plural(d.concepts, "Concept page")].filter(Boolean).join(", ");
      if (counts) facts.push(counts);
      if (d.secrets.length) facts.push(`needs ${d.secrets.join(", ")}`);
      const can = canWords(d.can);
      if (can) facts.push(can);
    } else facts.push("archive not read yet");
    out.push(`- [${h.package}](${base}/index/packages/${h.package}): ${h.description ? `${oneLine(h.description)} — ` : ""}${facts.join("; ")}`);
  }
  out.push("", "## Concepts", "");
  if (concepts.length === 0) out.push("No listed package carries a Concept page yet.");
  for (const c of concepts) {
    const notes = [c.description && oneLine(c.description), c.parent ? `under ${c.parent}` : "a root", `in ${c.packages.map((p) => p.package).join(", ")}`].filter(Boolean).join(" — ");
    out.push(`- [${c.name}](${base}/index/concepts/${encodeURIComponent(c.name)}): ${notes}`);
  }
  out.push("", "## Optional", "");
  if (opts.store) out.push(`- [The store page](${opts.store}/?store=1): the same, for a person — a package's Install link there opens their strut's Packages dialog on the name`);
  out.push(`- [strut](https://github.com/stakwork/strut): the workflow engine these packages install into`);
  return out.join("\n") + "\n";
}

/** `InitializeResult.instructions` for the index door: what the index is,
 *  that everything is derived and an install re-verifies, how a person
 *  installs. */
export function indexInstructions(opts: { publicUrl: string; store?: string }): string {
  const link = opts.store ? ` (${opts.store}/?store=1&pkg=<publisher/name>)` : "";
  return (
    `This is a strut PACKAGE INDEX at ${opts.publicUrl} — the phone book of a package store: it lists publishers, each by the public key that signs its catalog, and follows every listed publisher's public catalog. Here you find what people have published for strut, the workflow engine — PACKAGES of workflows (automations), steps, apps (front ends over workflows) and Concept pages (knowledge), each pinned by its digest. ` +
    `search_packages finds packages by words (each hit says what the release holds, read off its archive); get_package reads one package's page — its apps, each workflow's inputs and what it runs, its steps and the secrets they read, its Concept pages, its README, and \`can\`: whether running it spends (a model call), acts (a step that writes to the world) or runs code; get_concept browses the Concept tree the packages carry, or reads one page. ` +
    `Everything here is DERIVED and unsigned past the index card: a reading of the publishers' catalogs and archives as this index crawled them, never a check — an install re-verifies the package against its publisher's own signed catalog and re-reads its files through the real parsers. ` +
    `Nothing here installs, and you cannot: a package is installed on a PERSON's own strut, on their yes — from its UI's Packages dialog (Find the name, then Install), from this store's Install link${link}, which opens that dialog on the name, or proposed by an agent that holds strut's package/install tool there (a card the person approves). Tell them the name, publisher/name, and what the page says it needs and can do.`
  );
}
