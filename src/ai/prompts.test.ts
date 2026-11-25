import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRegistry } from "../steps/registry.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { STRUT_CONCEPTS, conceptFiles, parseConceptFile } from "../concept-seed.js";
import { BUILDER_PROCEDURE, BUILD_APP_ARTIFACT, BUILD_VERIFIED, CHAT_TOOLS, JOB_TOOLS, PAGE_TOOLS, SYSTEM, WORKFLOW_LANGUAGE, buildSystem, builderRules, workflowLanguagePage, type AiDeps } from "./prompts.js";

// The builder chat's system prompt heads every chat's cached prefix
// (docs/builder.md, "History is append-only"): rendering it from the one source
// the builder job shares (plans/builder-job.md §1) must not move a byte.
// The fixtures are buildSystem's output as it was before the factoring, up
// to the steps listing — which follows the lib/ tree on disk, not this text.
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
const LISTING = "Available steps:\n";

async function deps(): Promise<AiDeps> {
  const registry = await createRegistry([]);
  return { workspace: new WorkspaceManager("/nonexistent-prompt-fixture"), registry, store: new MemoryRunStore(), getRegistry: async () => registry };
}

function splitAtListing(system: string): [string, string] {
  const at = system.indexOf(LISTING) + LISTING.length;
  return [system.slice(0, at), system.slice(at)];
}

describe("the builder chat's prompt, rendered from the one source", () => {
  it("is byte-identical to the stored rendering, every optional section off", async () => {
    const [head, tree] = splitAtListing(await buildSystem(await deps()));
    assert.equal(head, await fixture("chat-system.txt"));
    assert.match(tree, /^steps\/\n {2}core\/\n/);
    assert.equal(head, `${SYSTEM}\n\n${LISTING}`);
  });

  it("is byte-identical with every optional section on: claims, the host's section, the models, the graph", async () => {
    const full: AiDeps = {
      ...(await deps()),
      claims: {} as AiDeps["claims"],
      hostSystem: "  HOST SECTION: what this deployment builds.\n",
      models: { default: "claude-sonnet-5-5", available: ["anthropic", "openai"], keyNames: { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", xai: "XAI_API_KEY" } },
      graph: { kind: "neo4j", cfg: { namespace: "default" } } as unknown as AiDeps["graph"],
    };
    const [head] = splitAtListing(await buildSystem(full));
    assert.equal(head, await fixture("chat-system-full.txt"));
  });

  it("with the deployment's model list (STRUT_MODELS), names those models and never asks for a key", async () => {
    const system = await buildSystem({
      ...(await deps()),
      models: { default: "anthropic/claude-opus-5-5", available: ["anthropic"], keyNames: { anthropic: "ANTHROPIC_API_KEY" }, listed: ["anthropic/claude-opus-5-5", "numes/z-ai/glm-5.3"] },
    });
    assert.ok(system.includes("LLM models this deployment allows: anthropic/claude-opus-5-5, numes/z-ai/glm-5.3 (default model: anthropic/claude-opus-5-5)."));
    assert.ok(!system.includes("ANTHROPIC_API_KEY"), "no key to ask for");
    assert.ok(!system.includes("LLM providers with a key configured"));
  });

  it("is the chat's first line, then builderRules in the chat's names; the MCP door's procedure is its last part", () => {
    assert.equal(SYSTEM, `You are a workflow builder. Users describe what they want and you create workflows. A user may call a workflow a "strut": it means a workflow.\n\n${builderRules(CHAT_TOOLS)}`);
    assert.ok(SYSTEM.endsWith(`\n\n${BUILDER_PROCEDURE}`));
    assert.ok(BUILDER_PROCEDURE.startsWith("Workflow:\n1. Call list_workflows FIRST"));
  });

  it("the job's names are steps the registry has", async () => {
    const registry = await createRegistry([]);
    const { chat, app, ...names } = JOB_TOOLS;
    assert.equal(chat, false);
    for (const [role, type] of Object.entries(names)) assert.ok(registry[type], `${role}: ${type}`);
    for (const verb of ["list", "get", "init", "checkout", "build", "publish", "look"]) assert.ok(registry[`${app}${verb}`], `${app}${verb}`);
  });
});

// The same rules as a Concept page, for the `job` agent to open
// (plans/one-job-agent.md §2): the third rendering.
describe("the Workflow Language page, rendered from the same source", () => {
  const FILE = `${WORKFLOW_LANGUAGE}.md`;

  it("the file strut ships is the rendering: change the rules, then `npm run render:concepts`", async () => {
    const shipped = await readFile(new URL(`../concepts/${FILE}`, import.meta.url), "utf-8");
    assert.equal(shipped, workflowLanguagePage(), `src/concepts/${FILE} is behind src/ai/prompts.ts: run \`npm run render:concepts\``);
  });

  it("is the builder job's rules but for two lines: the job agent's shell, and where the App page is", () => {
    const job = builderRules(JOB_TOOLS).split("\n");
    const page = builderRules(PAGE_TOOLS).split("\n");
    assert.equal(page.length, job.length);
    const changed = page.flatMap((line, i) => (line === job[i] ? [] : [[job[i]!, line] as const]));
    assert.equal(changed.length, 2, changed.map(([, line]) => line.slice(0, 60)).join(" | "));

    // The shell: the chat's line, in the job's directory and the job's names.
    const [[noShell, bash], [appAtEnd, appUnder]] = changed as [readonly [string, string], readonly [string, string]];
    assert.ok(noShell.startsWith("- No shell here:"));
    assert.ok(bash.startsWith("- bash(command): BUILD-TIME shell in the job's directory (when offered) — probe an API's real response shape with curl"), bash);
    const chatBash = builderRules(CHAT_TOOLS).split("\n").find((l) => l.startsWith("- bash("))!;
    const asChat = bash
      .replace("bash(command)", "bash(command, timeoutMs?)")
      .replace("the job's directory", "the server's data directory")
      .replace("clone a repo to", "clone a repo into scratch/ to")
      .replace("inspect the files a run left there", "inspect a run's file outputs under artifacts/<runId>/")
      .replace("meta/run-step", "run_step");
    assert.equal(asChat, chatBash, "every other word is the chat's");

    // The App page: read by name, since no prompt ends with a list here.
    assert.ok(appAtEnd.includes("Follow the App page listed at the end of this prompt (when this server has one)"));
    assert.equal(appUnder, appAtEnd.replace("listed at the end of this prompt", "under Workflow Builder"));
  });

  it("parses as a page with no parent yet, the rules whole, then what a build owes, word for word", async () => {
    const c = parseConceptFile(FILE, workflowLanguagePage(), STRUT_CONCEPTS.prefix);
    assert.equal(c.name, "Workflow Language");
    // Under `Workflow Builder` it would be listed as a kind to open in the
    // chat's, the builder job's and the orchestrator's prompts.
    assert.deepEqual(c.parents, [], "no prompt lists it until a page says to open it");
    assert.deepEqual(Object.keys(c.attributes), ["description"]);
    assert.ok(c.docs!.startsWith(`${c.description}\n\nA workflow is YAML with this shape:`));
    assert.ok(c.docs!.includes(builderRules(PAGE_TOOLS)));
    assert.ok(c.docs!.endsWith(`Be concise. Don't over-explain.\n\n${BUILD_VERIFIED}\n\n${BUILD_APP_ARTIFACT}`));
    assert.doesNotMatch(c.docs!, /No shell here|at the end of this prompt|<<strut:/);

    // Never the chat's names or mechanics.
    for (const chat of ["list_steps", "get_step", "run_step", "create_workflow", "run_workflow", "ask_user", "request_secret", "graph_query", "set_automation", "app_build", "bash(command, timeoutMs?)", "scratch/", "this chat", "[run-notification]"]) {
      assert.ok(!c.docs!.includes(chat), `the chat's ${chat}`);
    }
    // Every authoring step it names is one the registry has.
    const registry = await createRegistry([]);
    for (const type of new Set(c.docs!.match(/\b(?:meta|app|job|graph)\/[a-z][a-z-]*/g))) assert.ok(registry[type], `a step strut has: ${type}`);

    // Read from its file where there is no graph, as every shipped page is.
    const read = (await conceptFiles([STRUT_CONCEPTS]).get("workflow language"))!;
    assert.equal(read.docs, c.docs);
    assert.ok(!(await conceptFiles([STRUT_CONCEPTS]).get("Workflow Builder"))!.children.some((k) => k.name === c.name), "not among the kinds the builder's prompt lists");
  });
});
