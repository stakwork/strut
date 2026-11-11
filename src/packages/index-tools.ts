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
 *   search_live      what the listed servers SHOW LIVE — their public views,
 *                    and what anyone may run there, free or for sats
 *                    (plans/public-view-listing.md, work item 2)
 *
 * And `GET /llms.txt` at the index's root (`llmsTxt`, llmstxt.org): the
 * same store as ONE markdown page for an agent that fetches URLs rather
 * than speaks MCP — what the index is, the door above, the open JSON
 * reads, every listed package with what it holds, every Concept page,
 * every live server and what anyone may run on it — each a link to its
 * JSON page here or to the server itself, so the agent reads on without a
 * browser.
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
import type { IndexLiveItem } from "./index.js";
import { priceWords } from "../public-agents.js";

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

/** What an agent does with a live item: it lives on its SERVER, not here. */
const LIVE_IS_ON_ITS_SERVER =
  "A live item is NOT a package: nothing installs and nothing runs here. It is what its server shows now, as this index last read it — the server's own answer is the truth. A runnable item runs ON its server with no account: connect to that server's MCP door (`mcp`: list_public, run_workflow, call_tool, get_run, get_credit) or read its `llms.txt`, which says how to run it over plain HTTP and how a priced one is paid (an L402 invoice, sats over Lightning).";

/** Where a live item is reached on its server: its llms.txt, its MCP door,
 *  and — for an item anyone may run — the route that runs it. */
export function liveLinks(item: Pick<IndexLiveItem, "url" | "kind" | "name" | "run">): { llms: string; mcp: string; run_at?: string } {
  const base = item.url.replace(/\/+$/, "");
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  const run_at = !item.run ? undefined : item.kind === "workflow" ? `${base}/public/workflows/${encodeURIComponent(item.name)}/run` : item.kind === "step" ? `${base}/public/steps/${enc(item.name)}/run` : undefined;
  return { llms: `${base}/llms.txt`, mcp: `${base}/public/mcp`, ...(run_at ? { run_at } : {}) };
}

/** A live item's price in words (public-agents.ts `priceWords`, the server's own). */
export function livePriceWords(item: Pick<IndexLiveItem, "kind" | "run">): string | undefined {
  if (!item.run || (item.kind !== "workflow" && item.kind !== "step")) return undefined;
  return priceWords({ ...item.run, kind: item.kind, recent: item.run.recent ?? { days: 30, runs: 0, average: 0 } });
}

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
        "One package's PAGE: { package, publisher, key, urls, description?, releases (newest first, yanked kept), channels, readAt, detail?, detailError?, store? }. `detail` is the newest release read off its archive — `apps` (title, grants, `can`), `workflows` (each with its `inputs`, the step types it runs, its `grants`, `secrets`, `can`, `claims`), `steps` (effect, the secrets they read, the lint's findings), `concepts` (name, description, parents — a page's docs through get_concept), the README (cut at " +
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
        "The CONCEPT TREE the listed packages carry — knowledge pages (`concepts/*.md`: a name, a description, the parents, docs), folded across every package into one tree. " +
        "With no `name`: the entries, each { name, description?, parents?, packages: [{ package, version }] } — every word of `query` must match a name or description; empty lists the whole tree. " +
        "With `name`: that page — the entry plus `docs` (the first package's text), `children` (the pages naming it among their parents) and `parents` (its ancestors, nearest first, through each one's first parent) — or { error } when no listed package carries it. " +
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

    search_live: tool({
      description:
        "Search what the servers listed in this index SHOW LIVE — each one's PUBLIC VIEW, read from the server itself: apps, workflows, steps and Concept roots, and what anyone may RUN there, free or for sats. Every word of `query` must match an item's name, title, description or publisher; empty lists everything (up to `limit`). " +
        "Each item: { publisher, url (the server), kind: app | workflow | step | concept, name, title?, description?, version?, runs?, pages?, run?, definition?, llms, mcp, run_at?, price? } — `run` is there when anyone may run it: { base, markup, capUsd, reserve, results, recent? } in dollars, and `price` says it in words; `definition: false` when only running it is public, not its definition; `run_at` is the route that runs it. " +
        LIVE_IS_ON_ITS_SERVER,
      inputSchema: z.object({
        query: z.string().default("").describe("Words to match, e.g. \"echo\" or a publisher's name; empty lists everything."),
        runnable: z.boolean().default(false).describe("true: only what anyone may run."),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: async ({ query, runnable, limit }) => {
        const found = (await index.live(query)).filter((i) => !runnable || !!i.run);
        const items = found.slice(0, limit).map((i) => {
          const price = livePriceWords(i);
          return { ...i, ...liveLinks(i), ...(price ? { price } : {}) };
        });
        return { items, total: found.length, ...links.browse(query), how: LIVE_IS_ON_ITS_SERVER };
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
 *  the packages carry), `## Live` (every server whose public view this
 *  index lists, and each thing anyone may run there with its price — a
 *  link to the server, never a page here) and `## Optional` (the store page
 *  for a person) —
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
  const [info, packages, concepts, live] = await Promise.all([index.info(), index.search("", 500), index.concepts(""), index.live("")]);
  const out: string[] = [
    `# strut package index at ${host}`,
    "",
    `> The store of PACKAGES people published for strut, the workflow engine: workflows (automations), steps, apps (front ends over workflows) and Concept pages (knowledge), each pinned by its digest. This index is the phone book — it lists publishers by the public key that signs each one's catalog and follows every listed catalog. Everything here is DERIVED and unsigned past the index card: a reading of the publishers' catalogs and archives as this index crawled them, never a check — an install re-verifies the package against its publisher's own signed catalog and re-reads its files through the real parsers.`,
    "",
    `For an agent: this index is an MCP server — \`claude mcp add --transport http strut-store ${base}/index/mcp\` gives you search_packages, get_package, get_concept and search_live with no credential. The same reads are plain JSON, open to anyone, under Reads below; every package and Concept link on this page is one of them.`,
    "",
    INSTALL_IS_A_PERSONS_ACT,
    "",
    "## Reads",
    "",
    `- [Search](${base}/index/packages?q=): every listed package at its newest release, \`{ packages: [{ package, publisher, key, urls, version, digest, description?, license?, requires?, detail? }] }\`; every word of \`q\` must match the name, description or publisher, empty lists all (\`limit\`, 100). \`detail\` is what the archive holds: the apps, counts of workflows, steps and Concept pages, the secrets it needs, \`can\`, whether it has a README`,
    `- [A package's page](${base}/index/packages/{publisher}/{name}): its releases and channels, and \`detail\` — apps (title, grants, \`can\`), workflows (inputs, the step types they run, grants, secrets, claims), steps (effect, the secrets they read, lint findings), Concept pages, the README, the secrets the whole package needs, and \`can: { spends, acts, code }\`: whether running it reaches a model call, a step that acts on the world, or code`,
    `- [The Concept tree](${base}/index/concepts?q=): the knowledge pages the packages carry, folded into one tree, \`{ concepts: [{ name, description?, parents?, packages }] }\`; one page with its docs, children and parents at ${base}/index/concepts/{name}`,
    `- [The index card](${base}/index/catalog): the signed list of publishers (Ed25519 over RFC 8785 JSON, \`strut-index\`), what a strut follows${info ? ` — key ${info.key}` : ""}`,
    `- [What the servers show live](${base}/index/live?q=): every listed server's public view as last read, \`{ items: [{ publisher, url, kind, name, title?, description?, run?, definition? }] }\` — \`url\` the server, \`run\` the price when anyone may run it there (dollars); every word of \`q\` must match`,
    `- [MCP](${base}/index/mcp): POST, JSON-RPC over HTTP, stateless, no credential — the four tools above`,
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
    const notes = [c.description && oneLine(c.description), c.parents?.length ? `under ${c.parents.join(", ")}` : "a root", `in ${c.packages.map((p) => p.package).join(", ")}`].filter(Boolean).join(" — ");
    out.push(`- [${c.name}](${base}/index/concepts/${encodeURIComponent(c.name)}): ${notes}`);
  }
  // The live servers (plans/public-view-listing.md, work item 2): each one a
  // line to its own llms.txt, then what anyone may run there, priced — run ON
  // the server, never here.
  out.push("", "## Live", "");
  const rows = Object.entries(info?.live ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) out.push("No server's public view is listed yet.");
  else {
    out.push(
      "Servers whose PUBLIC VIEW this index lists, read live from each one as last crawled. What anyone may run there runs ON that server, with no account: its own llms.txt says how, over its MCP door (`<server>/public/mcp`) or plain HTTP, and how a priced run is paid (an L402 invoice, sats over Lightning).",
      "",
    );
  }
  for (const [prefix, row] of rows) {
    const base = row.url.replace(/\/+$/, "");
    const brief = info!.liveCrawled.find((c) => c.prefix === prefix);
    const shows = brief ? [plural(brief.apps ?? 0, "app"), plural(brief.workflows ?? 0, "workflow"), plural(brief.steps ?? 0, "step"), plural(brief.concepts ?? 0, "Concept page"), brief.runnable ? `${brief.runnable} ${brief.runnable === 1 ? "thing" : "things"} anyone may run` : ""].filter(Boolean).join(", ") : "";
    const notes = [row.description && oneLine(row.description), `served at ${base}`, shows ? `shows ${shows}` : brief?.error ? `not read: ${oneLine(brief.error)}` : "not read yet", `MCP at ${base}/public/mcp`].filter(Boolean).join(" — ");
    out.push(`- [${prefix}](${base}/llms.txt): ${notes}`);
    for (const item of live.filter((i) => i.publisher === prefix && i.run)) {
      const at = liveLinks(item).run_at!;
      const what = [item.description && oneLine(item.description), `${item.kind === "step" ? "a step to call" : "a workflow to run"} on ${prefix}`, livePriceWords(item), item.definition === false ? "its definition is not public" : ""].filter(Boolean).join(" — ");
      out.push(`- [${item.name}](${at}): ${what}`);
    }
  }
  out.push("", "## Optional", "");
  if (opts.store) out.push(`- [The store page](${opts.store}/?store=1): the same, for a person — a package's Install link there opens their strut's Publish dialog on its Packages tab, on the name`);
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
    `search_packages finds packages by words (each hit says what the release holds, read off its archive); get_package reads one package's page — its apps, each workflow's inputs and what it runs, its steps and the secrets they read, its Concept pages, its README, and \`can\`: whether running it spends (a model call), acts (a step that writes to the world) or runs code; get_concept browses the Concept tree the packages carry, or reads one page; search_live finds what the listed servers show LIVE — their public views, and what anyone may run there, free or for sats, ON that server (its \`mcp\` door or its \`llms.txt\`), never here. ` +
    `Everything here is DERIVED and unsigned past the index card: a reading of the publishers' catalogs and archives as this index crawled them, never a check — an install re-verifies the package against its publisher's own signed catalog and re-reads its files through the real parsers. ` +
    `Nothing here installs, and you cannot: a package is installed on a PERSON's own strut, on their yes — from its UI's Publish dialog, Packages tab (Find the name, then Install), from this store's Install link${link}, which opens that tab on the name, or proposed by an agent that holds strut's package/install tool there (a card the person approves). Tell them the name, publisher/name, and what the page says it needs and can do.`
  );
}
