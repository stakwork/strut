// Boots the default server on a fresh LadybugDB workspace graph, as Peel's
// desktop.js does (STRUT_WORKSPACE_BACKEND=ladybug, a host config that says
// `memory: "graph"`), with a module hook that refuses to load jarvis's
// bundled ontology (src/graph/fixtures/jarvis-ontology.ts). Then remembers a
// fact, recalls it and resolves its subject through the graph/* steps the
// assistant uses, and prints one JSON line with what it saw.
// `tsx scripts/fresh-peel-graph.ts <dataDir>`; jarvis-free-boot.test.ts runs
// it in a child process so its own imports cannot hide a load.
import { register } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = /\/src\/graph\/fixtures\/jarvis-ontology\.[jt]s$/;
const hook = `
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (${FIXTURE}.test(new URL(r.url).pathname)) throw new Error("jarvis ontology loaded: " + r.url + " from " + context.parentURL);
  return r;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: fresh-peel-graph.ts <dataDir>");
writeFileSync(join(dataDir, "host.json"), JSON.stringify({ memory: "graph" }));
Object.assign(process.env, {
  STRUT_WORKSPACE: dataDir,
  STRUT_WORKSPACE_BACKEND: "ladybug",
  STRUT_HOST_CONFIG: join(dataDir, "host.json"),
  STRUT_GRAPH_EMBEDDINGS: "off",
  STRUT_SCHEDULER: "0",
});

const { getApp } = await import("../src/server.js");
const { openGraphBackend, closeGraphBackends } = await import("../src/graph/backend.js");
const { ladybugConfigFromEnv } = await import("../src/graph/wiring.js");
const { default: assertStep } = await import("../src/steps/lib/graph/assert.js");
const { default: graphSearch } = await import("../src/steps/lib/graph/graph-search.js");
const { default: resolveStep } = await import("../src/steps/lib/graph/resolve.js");

await getApp();
// The server's own connection: a handle on the same config shares it.
const b = await openGraphBackend(ladybugConfigFromEnv(process.env, dataDir), { embeddings: false });
type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<any> };
const ctx = { runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services: { graph: b }, actor: "agent" };
const run = (step: Step, cfg: Record<string, unknown>) => step.run(step.input.parse(cfg), ctx);

const types = (await b.query("MATCH (n:Node {node_type: 'Schema'}) RETURN n.type AS t ORDER BY t")).map((r) => String(r["t"]));
const remembered = await run(assertStep, {
  facts: [
    {
      source_type: "Person",
      source_data: { name: "Kate Moss" },
      edge_type: "WORKS_WITH",
      target_type: "Person",
      target_data: { name: "Sam Lee" },
      text: "Kate Moss works with Sam Lee",
      create_schema_if_missing: true,
    },
  ],
});
const recalled = await run(graphSearch, { q: "who does Kate work with" });
const resolved = await run(resolveStep, { node_type: "Person", name: "kate moss" });
console.log(JSON.stringify({ types, remembered, recalled, resolved }));
await b.close();
await closeGraphBackends();
process.exit(0);
