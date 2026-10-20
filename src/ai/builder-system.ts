import type { GraphBackend } from "../graph/backend.js";
import { runSingleStep } from "../run-step.js";
import type { StepRegistry } from "../core.js";
import { renderConceptSection, type ConceptPage } from "../steps/lib/context/concept.js";

export type { ConceptPage };

/**
 * What the AI builder knows about THIS deployment, read off the knowledge
 * graph instead of written into a prompt — the default `chatSystem` on a
 * graph workspace (a host's own hook replaces it).
 *
 * `Workflow Builder` is a Concept (`src/concepts/Workflow Builder.md`,
 * seeded by `src/concept-seed.ts`). Its docs, and the name + description of
 * each Concept under it (`PARENT_OF`: the KINDS of thing built here), are
 * the deployment's section of the builder's system prompt. Asked to build
 * one of those kinds, the builder opens its page and reads the convention
 * there; nothing about any kind is in strut's prompt.
 *
 * One reading rule at every level: a Concept's docs are its page, its
 * children its table of contents. The section is the `context/concept`
 * step's — the one the `job` workflow puts its `Job` page in front of its
 * agent with — which reads with the step behind the tool the builder opens
 * every other page with (`graph/graph-get`, the builder's `graph_get`: by
 * name, with `children`), so what the prompt shows and what a read returns
 * cannot drift.
 *
 * The text has system authority over a builder that can publish steps and
 * run bash, and it comes from a node the workspace can edit: the docs are
 * capped, framed as the workspace's notes, and only the ENTRY page is
 * inlined — every other page arrives as a tool result.
 */
export const BUILDER_ENTRY = "Workflow Builder";

/** Pure: the entry page → the prompt section, opened with the builder's `graph_get`. */
export function renderBuilderSystem(page: ConceptPage): string {
  return renderConceptSection(page, "graph_get");
}

/** The entry page, read through the builder's own step; undefined when there
 *  is no graph or no such Concept. */
export async function builderSystem(deps: { graph?: GraphBackend; registry: StepRegistry; services: unknown }): Promise<string | undefined> {
  if (!deps.graph) return undefined;
  const res = await runSingleStep("context/concept", deps.registry, { ...(deps.services as object), graph: deps.graph }, {
    config: { name: BUILDER_ENTRY, tool: "graph_get" },
  });
  const text = (res.output as { text?: string } | undefined)?.text;
  if (res.status !== "success" || !text) {
    if (res.status !== "success") console.log(`[builder] no "${BUILDER_ENTRY}" page for the prompt: ${res.error?.message ?? "not found"}`);
    return undefined;
  }
  return text;
}
