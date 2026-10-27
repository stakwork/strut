import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRegistry } from "../steps/registry.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { BUILDER_PROCEDURE, CHAT_TOOLS, JOB_TOOLS, SYSTEM, buildSystem, builderRules, type AiDeps } from "./prompts.js";

// The builder chat's system prompt heads every chat's cached prefix
// (AGENTS.md, "History is append-only"): rendering it from the one source
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

  it("is the chat's first line, then builderRules in the chat's names; the MCP door's procedure is its last part", () => {
    assert.equal(SYSTEM, `You are a workflow builder. Users describe what they want and you create workflows.\n\n${builderRules(CHAT_TOOLS)}`);
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
