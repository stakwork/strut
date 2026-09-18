/**
 * Zod shapes for the claim / check authoring surfaces — shared by the chat
 * builder's tools (`ai/tools.ts`) and their `meta/*` twins, so both doors
 * describe a check the same way. The descriptions are the model-facing docs.
 */
import { z } from "zod";

export const subjectSchema = z
  .object({
    kind: z.enum(["step", "workflow"]).describe("What the claim is about: a custom step type, or a published workflow."),
    name: z.string().describe("Workflow name, or custom step type (e.g. 'clip/compute-times')."),
  })
  .describe("A claim's subject — the STABLE identity, never a version: the claim applies to whatever version is active when a run is verified.");

export const checkSpecSchema = z
  .object({
    type: z
      .string()
      .optional()
      .describe(
        "Registry step that RUNS the check: `exec` (a script — free, observed; prefer it. Config is { cmd, args?, script?, cwd? } — see get_step(\"exec\"); set cwd: \"{{ input.artifactsDir }}\" to work on the files the run produced), a custom step, `llm` / `agent` (a judgment — costs money, recorded as asserted), or `subflow` (a whole workflow, for anything bigger than a one-liner: config = { workflow, version?, input }). OMIT for an EXTERNAL check — one code cannot run — and give `description` instead.",
      ),
    config: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "That step's config. The observed subject IS the check's input: `{{ input.output.* }}` is the step's output, `{{ input.input.* }}` its resolved config (for a workflow: the run's input, with `{{ input.params.* }}` beside it), `{{ input.error.message }}` when it failed, plus `{{ input.runId }}`, `{{ input.path }}`, `{{ input.artifactsDir }}`. A `publish` check reads `{{ input.source }}` (step) / `{{ input.yaml }}` (workflow). The check must RETURN { supports: boolean, content: string, locator?: { path?, start_time?, end_time?, url? } } — never throw on a failed assertion, return supports:false. A bare `exec` with no JSON on stdout maps from its exit code (0 = supports) with the output tail as content.",
      ),
    name: z.string().optional().describe("Short label, e.g. 'stt fuzzy-match'. Defaults to the step type."),
    description: z
      .string()
      .optional()
      .describe("What the check observes. REQUIRED for an external check: what to look at, and why code cannot check it."),
    when: z
      .enum(["run", "publish"])
      .optional()
      .describe("`run` (default): fires on an execution of the subject. `publish`: fires when a new version is published, over its source — for lints."),
    policy: z
      .enum(["always", "on_change", "sample", "manual"])
      .optional()
      .describe(
        "When a run check fires. `always`: every verified run (default for free code checks — coverage comes from inputs). `on_change`: when the subject's version (or the check's own code) changed, it has no evidence yet, or its evidence is older than freshnessDays (default for llm/agent checks and external checks). `sample`: a sampleRate fraction of runs. `manual`: only on verify_run.",
      ),
    freshnessDays: z.number().int().positive().optional().describe("For on_change: re-run when the latest evidence is older than this (default 7) — catches environment drift."),
    sampleRate: z.number().gt(0).lte(1).optional().describe("For sample: fraction of runs, in (0, 1]."),
  })
  .describe("One instrument that can test the claim: a step check ({ type, config }) or an external check ({ description }).");

export const claimSpecSchema = z.object({
  text: z
    .string()
    .describe("ONE plain sentence about how the subject should BEHAVE — not its mechanism, and never its output schema restated. Describes the desired end state of a process. (e.g. 'The clip's audio contains the requested quote', 'Fetches only the requested caption languages', 'The file was downloaded from youtube', 'This is a valid birthday for this person')."),
  checks: z.array(checkSpecSchema).min(1).describe("At least one check. If code cannot check it, one external check saying what to look at and why."),
});

export const claimsArgSchema = z
  .array(claimSpecSchema)
  .optional()
  .describe(
    "The contract: claims about how this should behave, each with its checks. Author them IN THE SAME CALL as the code, before the first run. This arg only ever ADDS — a claim whose text exactly matches an active one is skipped, so republishing with the same list is a no-op; reword with edit_claim, remove with retire_claim.",
  );

export const CLAIMS_OFF = "Claims need the graph-backed workspace (this deployment keeps workflows and steps on the filesystem).";
