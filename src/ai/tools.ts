import { z } from "zod";
import { tool } from "ai";
import { runWorkflow } from "../runner.js";
import { AiDeps } from "./prompts.js";
import { lsSteps, searchSteps, readStepSource } from "./stepHelpers.js";
import { stepSchemas } from "./schemaHelpers.js";
import { runStep, cassettePath } from "../run-step.js";
import { stepHashesFor } from "../closure.js";
import type { ClaimActor } from "../claims-authoring.js";
import { checkSpecSchema, claimsArgSchema, subjectSchema } from "../claims-schemas.js";
import { ledgerIsEmpty, subjectsOfFlow } from "../ledger.js";
import { generateRunId, stepRunKey } from "../store.js";
import { formatValidationErrors, validateWorkflowYaml } from "../validate.js";
import { modelEvaluate } from "../evaluate.js";
import { resolveEvaluationModel } from "../llm.js";
import { graphWalkTool } from "./walk-tool.js";
// The shared authoring core — the same mechanism the meta/* steps' capability
// sits on (see authoring.ts): publish checks + strict load-verification, and
// the run-history reads. The chat tools layer their own policy on top (no
// ownership gating — this surface is human-supervised).
import {
  AI_PUBLISHER,
  coerceJsonArg,
  listRunSummaries,
  publishNewStep,
  publishStepVersion,
  readRun,
  searchRunEvents,
} from "../authoring.js";

// ── Run control ────────────────────────────────────────────────────────────

type RunControlAction = "cancel" | "pause" | "resume";
type ControlRun = NonNullable<AiDeps["controlRun"]>;

function runControlTool(controlRun: ControlRun, action: RunControlAction, description: string) {
  return tool({
    description,
    inputSchema: z.object({
      name: z.string().describe("Workflow name"),
      runId: z.string().describe("Run id (from run_workflow's response or list_runs)"),
    }),
    execute: async ({ name, runId }) => controlRun(name, runId, action),
  });
}

function runControlTools(controlRun: ControlRun) {
  return {
    cancel_run: runControlTool(
      controlRun,
      "cancel",
      "Cancel a run that is LIVE in this process — e.g. a detached run_workflow you launched with the wrong input, or one you want to stop after seeing partial output in get_run. Cancellation is cooperative: the run stops at its next step boundary and finalizes as cancelled (a [run-notification] follows for chat-launched runs). A run that already finished reports its terminal status instead.",
    ),
    pause_run: runControlTool(
      controlRun,
      "pause",
      "Pause a LIVE run at its next step boundary (in-flight steps finish; no new ones start) so you or the user can inspect it with get_run before deciding to resume_run or cancel_run. Only live runs can be paused.",
    ),
    resume_run: runControlTool(
      controlRun,
      "resume",
      "Resume a run you paused with pause_run (in-memory; the run continues from where it parked). For a run cut off by a crash/restart, tell the user to use the UI's durable resume instead.",
    ),
  };
}

// ── Tools ──────────────────────────────────────────────────────────────────

export function buildTools(deps: AiDeps) {
  /** The static check behind validate_workflow — also the gate on
   *  create_workflow / edit_workflow, so an invalid YAML never becomes a
   *  version. Registry + workflow list come from deps at call time. */
  const validate = async (yaml: string, name?: string) => {
    const workflows = await deps.workspace.listWorkflows().catch(() => []);
    return validateWorkflowYaml(yaml, {
      registry: deps.registry,
      workflows: workflows.map((w) => ({ name: w.name, versions: w.versions })),
      name,
    });
  };
  // The claims layer (plans/claims.md), where the host turned it on: none of
  // the claim tools, and no `claims` arg, are offered without it. This
  // surface is human-supervised, so it is NOT publisher-scoped (like
  // edit_step); what it writes is still stamped `ai`, which keeps the grader
  // deny-list on its checks.
  const claims = deps.claims ?? null;
  const actor: ClaimActor = { publisher: AI_PUBLISHER, scoped: false };
  const claimsArg = claims ? { claims: claimsArgSchema } : {};
  const verifier = claims ? (deps.verifier ?? null) : null;
  /** The contract of what a launch can execute, every check `pending` — so
   *  the model reads what its work is claimed to do in the RESULT of the run
   *  it just made, and knows a verdict is coming (plans/claims.md §5). */
  const pendingContract = async (flow: Parameters<typeof subjectsOfFlow>[0], workflowName?: string) => {
    if (!verifier) return {};
    try {
      const ledger = await verifier.pendingLedger(await subjectsOfFlow(flow, deps.workspace, workflowName));
      return ledgerIsEmpty(ledger)
        ? {}
        : { claims: ledger, verify: "pending — the checks run now, detached; a [verify-notification] will start your next turn with each claim's status. Finish this turn normally." };
    } catch {
      return {}; // the run's result never depends on the graph being reachable
    }
  };

  /** `run_when: publish` checks fire at the end of a publish; their verdicts
   *  ride along on the result. */
  const publishChecks = async (kind: "step" | "workflow", name: string) => {
    if (!verifier) return {};
    const r = await verifier.verifyPublish(kind === "step" ? { kind, type: name } : { kind, name }).catch(() => null);
    return r && r.checks.length ? { publishChecks: r.checks.map((k) => ({ claim: k.claimId, check: k.checkId, lastVerify: k.lastVerify })) } : {};
  };
  type ClaimsArg = z.infer<typeof claimsArgSchema>;

  /** Non-blocking: warnings ride along on a successful publish. */
  const withWarnings = <T extends object>(result: T, v: { warnings: Array<{ path: string; message: string }> }) =>
    v.warnings.length ? { ...result, warnings: v.warnings } : result;

  return {
    list_steps: tool({
      description:
        "List contents of a step path, like a filesystem. Valid paths: 'steps' (shows core/, lib/, custom/), 'steps/core', 'steps/lib', 'steps/lib/<namespace>', 'steps/custom'.",
      inputSchema: z.object({
        path: z
          .string()
          .default("steps")
          .describe(
            "Path to list. Defaults to 'steps' (the root). Use 'steps/lib' to see lib namespaces, 'steps/lib/github' to see steps in a namespace, etc.",
          ),
      }),
      execute: async ({ path }) => lsSteps(path, deps),
    }),

    search_steps: tool({
      description:
        "Search for step types by keyword. Matches against the step type name and its description across core, lib, and custom steps. Returns ranked matches.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Search keywords, e.g. 'github pr' or 'http request'"),
      }),
      execute: async ({ query }) => searchSteps(query, deps),
    }),

    get_step: tool({
      description:
        "Read a step type's docs before using it: `description` (what it does + a YAML example), `input` (JSON Schema of its config — every field's meaning, default, enum and nesting), and `output` (JSON Schema of what it returns, for {{ id.field }} templates; absent when the step's output is untyped — the description then states the shape). Pass source:true ONLY to author or edit a step (read a custom step before edit_step; mirror a lib step's implementation) — it adds the full TypeScript source of a lib/custom step, which you don't need to use the step in a workflow. Core steps have no source. `recentRuns` (when present) counts this step's KEPT run_step runs — read them with list_runs / get_run using the name `step:<type>`.",
      inputSchema: z.object({
        type: z.string().describe("Step type, e.g. 'http' or 'github/fetch-pr'"),
        source: z
          .boolean()
          .default(false)
          .describe("also return the TypeScript source (lib/custom steps) — for authoring/editing, not for using a step"),
      }),
      execute: async ({ type, source }) => {
        const def = deps.registry[type];
        if (!def) {
          return { error: `Step type "${type}" not found` };
        }
        const recentRuns = (await deps.store.listRuns(stepRunKey(type))).length;
        const verifyCostUsd = deps.verifier ? await deps.verifier.costOf({ kind: "step", type }).catch(() => 0) : 0;
        return {
          type,
          description: def.description,
          ...stepSchemas(def),
          ...(source ? { source: (await readStepSource(type, deps)) ?? null } : {}),
          // Kept single-step runs: list_runs / get_run on the key `step:<type>`.
          ...(recentRuns ? { recentRuns } : {}),
          // What this step's paid checks have cost so far — what its claims cost to keep true.
          ...(verifyCostUsd > 0 ? { verifyCostUsd } : {}),
        };
      },
    }),

    list_secrets: tool({
      description:
        "List the NAMES of credentials available in the deployment's secret store (e.g. GITHUB_TOKEN, GOOGLE_SERVICE_ACCOUNT_JSON). Returns names + metadata ONLY — never the secret values. Use this before authoring a step that needs auth: reference an existing name in ctx.services.secrets.get(\"NAME\"), and if the credential you need isn't listed, tell the user to add it via the Secrets dialog (the value is never visible to you).",
      inputSchema: z.object({}),
      execute: async () => {
        if (!deps.secrets) {
          return { error: "Secret store is not available in this deployment." };
        }
        const secrets = await deps.secrets.list();
        return { secrets: secrets.map((s) => ({ name: s.name, updatedAt: s.updatedAt })) };
      },
    }),

    create_step: tool({
      description:
        "Author a NEW custom step type from TypeScript source. The code is a self-contained strut step: `import { z, defineStep } from \"strut\"` and `export default defineStep({ type, input, output, async run(cfg, ctx) {...} })`. Reach external capabilities through `ctx.services` — for network calls use `ctx.services.http(url, opts)` and for credentials `ctx.services.secrets.get(name)` (NOT the global fetch / process.env), so the step is recordable/replayable by run_step's cassette and secrets are scrubbed from fixtures. Call get_step(\"http\", source:true) to read the canonical ctx.services.http example. Prefer raw REST over vendor SDKs; only import a package other than \"strut\" if the deployment has pre-installed it. Use this only for step types that don't exist yet; use edit_step to change an existing one. Publishing as a new step creates version v1.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Step type name. Slashes nest it (e.g. 'concepts/my-fetcher') and become the registry type.",
          ),
        code: z
          .string()
          .describe(
            "Full TypeScript source. Shape: import { z, defineStep } from \"strut\"; export default defineStep({ type: \"<name>\", input: z.object({...}), output: z.any(), async run(cfg, ctx) { /* use ctx.services for capabilities */ } });",
          ),
        description: z.string().optional(),
        ...claimsArg,
      }),
      execute: async ({ name, code, description, ...rest }) => {
        const contract = (rest as { claims?: ClaimsArg }).claims;
        const invalid = await claims?.validateClaimsArg(contract, actor);
        if (invalid) return { error: `Nothing was published — fix the claims first. ${invalid.error}` };
        const result = await publishNewStep(deps, name, code, description, AI_PUBLISHER);
        deps.registry = await deps.getRegistry();
        const ledger = result.ok && claims ? { claims: await claims.applyClaimsArg({ kind: "step", name }, contract, actor), ...(await publishChecks("step", name)) } : {};
        if (result.ok && result.loaded === false) {
          const { loadError, ...ok } = result;
          return { ...ok, ...ledger, warning: `Published but failed to load into the registry: ${loadError}` };
        }
        return { ...result, ...ledger };
      },
    }),

    edit_step: tool({
      description:
        "Publish a NEW VERSION of an EXISTING custom step (e.g. tweak its prompt, logic, or config schema). Same self-contained rules as create_step. Call get_step(type, source:true) first to read the current source. Identical content is a no-op; a change increments the version (v1 → v2 → …) and prior versions are kept for rollback. Built-in core/lib steps cannot be edited.",
      inputSchema: z.object({
        type: z.string().describe("Existing custom step type to edit, e.g. 'concepts/decide'."),
        code: z
          .string()
          .describe("Full updated TypeScript source (same self-contained shape as create_step)."),
        description: z.string().optional(),
        ...claimsArg,
      }),
      execute: async ({ type, code, description, ...rest }) => {
        const contract = (rest as { claims?: ClaimsArg }).claims;
        const invalid = await claims?.validateClaimsArg(contract, actor);
        if (invalid) return { error: `Nothing was published — fix the claims first. ${invalid.error}` };
        const result = await publishStepVersion(deps, type, code, description);
        deps.registry = await deps.getRegistry();
        const ledger = result.ok && claims ? { claims: await claims.applyClaimsArg({ kind: "step", name: type }, contract, actor), ...(await publishChecks("step", type)) } : {};
        if (result.ok && result.loaded === false) {
          const { loadError, ...ok } = result;
          return { ...ok, ...ledger, warning: `Published but failed to load into the registry: ${loadError}` };
        }
        return { ...result, ...ledger };
      },
    }),

    validate_workflow: tool({
      description:
        "Statically check workflow YAML WITHOUT publishing — call this before create_workflow / edit_workflow so a typo doesn't become a published version. Errors (would fail or hang at run time): YAML/unquoted-template problems, missing/duplicate/unreferenceable step ids, unknown step types, `depends` on unknown ids, dependency cycles, template references to unknown roots ({{ foo.x }} where foo is not a step id / input / params / a loop variable), config fields that fail the step's schema (template-valued fields are skipped — they resolve at run time), subflows naming a workflow/version that doesn't exist. Warnings: unknown config fields, `when` without an `if` gate among its depends, references to steps that aren't upstream dependencies. Returns { ok, errors: [{path, message}], warnings: [...], summary }.",
      inputSchema: z.object({
        yaml: z.string().describe("Full workflow YAML to check"),
        name: z
          .string()
          .optional()
          .describe("The name you will publish under (lets a YAML without `name:` pass, as create_workflow stamps it in)."),
      }),
      execute: async ({ yaml, name }) => validate(yaml, name),
    }),

    create_workflow: tool({
      description:
        "Create and publish a NEW workflow from YAML. If the name already " +
        "exists, a numeric suffix is appended (e.g. `send-email-2`). The " +
        "response includes the final name used. To publish a new version of " +
        "an EXISTING workflow, use `edit_workflow` instead. Pass `category` " +
        "to group the workflow in the UI sidebar (e.g. an experiment or " +
        "project name) — set it when the user asks for one or when the " +
        "workflow clearly belongs to an existing category (see " +
        "list_workflows for categories already in use). The YAML is " +
        "validated first (same checks as validate_workflow): on errors " +
        "nothing is published and the error lists them; warnings are " +
        "returned alongside a successful publish.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name (kebab-case)"),
        yaml: z.string().describe("Full workflow YAML"),
        description: z.string().optional(),
        category: z
          .string()
          .optional()
          .describe(
            "Optional sidebar grouping label (kebab-case, e.g. an experiment name). Omit to leave uncategorized.",
          ),
        ...claimsArg,
      }),
      execute: async ({ name, yaml, description, category, ...rest }) => {
        const v = await validate(yaml, name);
        if (!v.ok) return { error: formatValidationErrors(v), validation: v };
        const contract = (rest as { claims?: ClaimsArg }).claims;
        const invalid = await claims?.validateClaimsArg(contract, actor);
        if (invalid) return { error: `Nothing was published — fix the claims first. ${invalid.error}` };
        const { name: finalName, version } = await deps.workspace.createWorkflow(
          name,
          yaml,
          description,
          category,
        );
        // Rebuild registry in case the workflow references new patterns
        deps.registry = await deps.getRegistry();
        return withWarnings(
          {
            ok: true,
            name: finalName,
            version,
            renamed: finalName !== name,
            requested: name,
            ...(claims ? { claims: await claims.applyClaimsArg({ kind: "workflow", name: finalName }, contract, actor), ...(await publishChecks("workflow", finalName)) } : {}),
          },
          v,
        );
      },
    }),

    edit_workflow: tool({
      description:
        "Publish a NEW VERSION of an EXISTING workflow from YAML. Call " +
        "get_workflow first to read the current source. Identical content is " +
        "a no-op; a change increments the version (v1 → v2 → …) and activates " +
        "it, retaining prior versions for rollback. Use this for STRUCTURAL " +
        "changes (adding/removing steps, rewiring `depends`, or promoting a " +
        "winning `params` default). To merely try a different prompt or " +
        "threshold value, do NOT publish a version — pass `params` to " +
        "run_workflow instead (those are runs, not versions). The YAML is " +
        "validated first (same checks as validate_workflow): on errors no " +
        "version is published and the error lists them; warnings ride along " +
        "on success.",
      inputSchema: z.object({
        name: z.string().describe("Existing workflow name to edit"),
        yaml: z.string().describe("Full updated workflow YAML"),
        description: z.string().optional(),
        category: z
          .string()
          .optional()
          .describe(
            "Optional sidebar grouping label. Only pass to CHANGE the category (to merely re-categorize without editing YAML, use set_workflow_category).",
          ),
        ...claimsArg,
      }),
      execute: async ({ name, yaml, description, category, ...rest }) => {
        const exists = (await deps.workspace.listWorkflows()).some(
          (w) => w.name === name,
        );
        if (!exists) {
          return {
            error: `Workflow "${name}" not found. Use create_workflow to author a new one.`,
          };
        }
        const v = await validate(yaml, name);
        if (!v.ok) return { error: formatValidationErrors(v), validation: v };
        const contract = (rest as { claims?: ClaimsArg }).claims;
        const invalid = await claims?.validateClaimsArg(contract, actor);
        if (invalid) return { error: `Nothing was published — fix the claims first. ${invalid.error}` };
        let result;
        try {
          result = await deps.workspace.publishWorkflowByContent(
            name,
            yaml,
            description,
            category,
          );
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        deps.registry = await deps.getRegistry();
        return withWarnings(
          {
            ok: true,
            name,
            version: result.version,
            changed: result.changed,
            ...(claims ? { claims: await claims.applyClaimsArg({ kind: "workflow", name }, contract, actor), ...(await publishChecks("workflow", name)) } : {}),
          },
          v,
        );
      },
    }),

    // ── Claims (plans/claims.md §2, door two) — graph-backed workspaces only.
    ...(claims
      ? {
          add_claim: tool({
            description:
              "State how a step or workflow SHOULD behave, with the check(s) that test it. One claim may be about SEVERAL subjects (a contract two steps share) — attach it rather than writing it twice. Use this for a subject you are not republishing; when you ARE publishing, pass `claims` to create_step / edit_step / create_workflow / edit_workflow instead. Every claim needs at least one check; evidence is produced by verifying runs, never by this call. Returns { id, checks: [ids] }.",
            inputSchema: z.object({
              subjects: z.array(subjectSchema).min(1),
              text: z.string().describe("ONE plain sentence: behavior, not mechanism; never the output schema restated."),
              checks: z.array(checkSpecSchema).min(1),
            }),
            execute: async ({ subjects, text, checks }) => claims.addClaim({ subjects, text, checks }, actor),
          }),

          list_claims: tool({
            description:
              "A subject's active claims, each with its checks (id, step type + config or external description, when/policy) and its status COMPUTED from evidence: supported | refuted | stale (evidence is about an older version) | unknown (never checked). `assertedOnly` = the verdict rests on a model's or person's word, nothing observed; `unverified` = active checks with no evidence about the active version; `openSlot` = an external check is waiting on someone.",
            inputSchema: z.object({ subject: subjectSchema }),
            execute: async ({ subject }) => {
              const listing = await claims.listClaims(subject);
              if (!("ok" in listing) || !verifier) return listing;
              const verifyCostUsd = await verifier.costOf(subject.kind === "step" ? { kind: "step", type: subject.name } : { kind: "workflow", name: subject.name }).catch(() => 0);
              return verifyCostUsd > 0 ? { ...listing, verifyCostUsd } : listing;
            },
          }),

          edit_claim: tool({
            description:
              "Reword a claim. Claims are immutable once written, so this creates a SUCCESSOR that supersedes it and returns the successor's id: attachments and checks carry over, the old evidence stays on the old node, and the successor starts `unknown` until a run is verified again. Never publishes a workflow/step version.",
            inputSchema: z.object({ id: z.string().describe("Claim id (from list_claims)"), text: z.string() }),
            execute: async ({ id, text }) => claims.editClaim(id, text, actor),
          }),

          retire_claim: tool({
            description: "Retire a claim that no longer holds as a requirement. It is never deleted — its evidence and history stay — it just stops being part of the contract.",
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }) => claims.retireClaim(id, actor),
          }),

          attach_claim: tool({
            description: "Attach an EXISTING claim to another subject — how a contract is shared (its checks come along), never by copying it. Each subject gets its own status. Attaching twice is a no-op.",
            inputSchema: z.object({ id: z.string(), subject: subjectSchema }),
            execute: async ({ id, subject }) => claims.attachClaim(id, subject, actor),
          }),

          detach_claim: tool({
            description: "Detach a claim from ONE subject (it stays on its others). A claim's last subject cannot be detached — retire the claim instead.",
            inputSchema: z.object({ id: z.string(), subject: subjectSchema }),
            execute: async ({ id, subject }) => claims.detachClaim(id, subject, actor),
          }),

          add_check: tool({
            description:
              "Add another instrument to an existing claim — e.g. a free `exec` on every run beside an `llm` judge on change. Each check keeps its own policy, cost and evidence stream; a refutation from ANY check on the active version makes the claim refuted.",
            inputSchema: z.object({ claim: z.string().describe("Claim id"), check: checkSpecSchema }),
            execute: async ({ claim, check }) => claims.addCheck(claim, check, actor),
          }),

          edit_check: tool({
            description:
              "Change a check (its step, config, when, policy…). Pass only the fields to change. Checks are immutable once written: this creates a SUCCESSOR and returns its id; the old check's evidence stops counting — a changed instrument has measured nothing yet — so the claim reads `unknown` until it runs again.",
            inputSchema: z.object({ id: z.string().describe("Check id (from list_claims)"), patch: checkSpecSchema }),
            execute: async ({ id, patch }) => claims.editCheck(id, patch, actor),
          }),

          retire_check: tool({
            description: "Retire a check. Refused when it is the claim's LAST active check — add the replacement first (add_check), or retire the claim.",
            inputSchema: z.object({ id: z.string() }),
            execute: async ({ id }) => claims.retireCheck(id, actor),
          }),

          ...(verifier
            ? {
                verify_run: tool({
                  description:
                    "Verify a finished run NOW and wait for it: run the checks of every claim on the subjects the run executed, and write the evidence. Runs are verified automatically after they finish, so use this to RE-verify — after adding or editing a claim or check (only checks with no evidence for this run yet execute; it never duplicates), to backfill an older run, or to fire `manual` checks. `name` is the workflow, or `step:<type>` for a kept run_step run. Returns `claims` — the ledger: every claim on those subjects with its computed status and each check's lastVerify: { ran } | { skipped: policy | budget | cannot-launch | unknown-version | denied, reason? } | { planned: <evidence id> }.",
                  inputSchema: z.object({
                    name: z.string().describe("Workflow name, or `step:<type>` for a kept single-step run"),
                    runId: z.string(),
                  }),
                  execute: async ({ name, runId }) => {
                    const result = await verifier.verifyRun(name, runId, { explicit: true });
                    if (result.skipped) return result;
                    return { ...result, claims: await verifier.ledger(result) };
                  },
                }),

                add_evidence: tool({
                  description:
                    "Record something YOU observed about a claim on a specific run — only what you actually saw with a tool (ffprobe output, a transcript you read, a graph_query result); `content` must say what and how. It is stored as ASSERTED (a model's word, flagged `assertedOnly` until a check observes the same thing), sourced to that run and the version it executed. If an external check is waiting on this run (an open slot), this answers it. Never use it to mark work as passing without looking.",
                  inputSchema: z.object({
                    claim: z.string().describe("Claim id (from list_claims)"),
                    name: z.string().describe("The run's workflow name, or `step:<type>` for a kept single-step run"),
                    runId: z.string(),
                    supports: z.boolean().describe("true: what you saw supports the claim; false: it refutes it"),
                    content: z.string().describe("What you observed, and with which tool — one bounded statement"),
                    subject: subjectSchema.optional().describe("Only when the run executed several of the claim's subjects"),
                    slot: z.string().optional().describe("Evidence id of the open slot to fill (from lastVerify.planned); found automatically for this run when omitted"),
                  }),
                  execute: async ({ claim, name, runId, supports, content, subject, slot }) =>
                    verifier.addEvidence({
                      claim,
                      name,
                      runId,
                      supports,
                      content,
                      ...(subject ? { subject: subject.kind === "step" ? { kind: "step" as const, type: subject.name } : { kind: "workflow" as const, name: subject.name } } : {}),
                      ...(slot ? { slot } : {}),
                      by: AI_PUBLISHER,
                      mode: "asserted",
                    }),
                }),
              }
            : {}),
        }
      : {}),

    set_workflow_category: tool({
      description:
        "Set or clear an existing workflow's sidebar category (the grouping " +
        "label in the UI). Metadata-only: no new version is published and the " +
        "workflow YAML is untouched. Use when the user asks to categorize, " +
        "re-categorize, or group workflows. Check list_workflows first to " +
        "reuse an existing category name where one fits.",
      inputSchema: z.object({
        name: z.string().describe("Existing workflow name"),
        category: z
          .string()
          .nullable()
          .describe("New category label, or null to clear it"),
      }),
      execute: async ({ name, category }) => {
        try {
          await deps.workspace.setWorkflowCategory(name, category);
          return { ok: true, name, category };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    set_active_version: tool({
      description:
        "ROLLBACK: make a prior version of a workflow or custom step the ACTIVE one — the version runs use (and, for steps, the one loaded in the registry). No new version is published and history is kept; later versions remain available to re-activate. Use this when a newer version turns out worse (\"go back to v2\") instead of republishing old source as yet another version. Call get_workflow first to see a workflow's versions; for a step, an unknown version here reports the available ones.",
      inputSchema: z.object({
        kind: z.enum(["workflow", "step"]).describe("What to roll back: a published workflow or a custom step."),
        name: z.string().describe("Workflow name, or custom step type (e.g. 'concepts/decide')."),
        version: z.string().describe("Version label to activate, e.g. 'v2'."),
      }),
      execute: async ({ kind, name, version }) => {
        try {
          if (kind === "workflow") {
            await deps.workspace.setActiveVersion(name, version);
          } else {
            if (deps.publishingEnabled === false) {
              return { error: "Step versioning is disabled in this deployment (the registry is provided in code)." };
            }
            await deps.workspace.setActiveStepVersion(name, version);
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        // A step switch changes what's loaded; a workflow switch may change
        // which custom steps are referenced. Either way, refresh.
        deps.registry = await deps.getRegistry();
        return { ok: true, kind, name, active: version };
      },
    }),

    list_workflows: tool({
      description:
        "List all published workflows in the workspace, with each one's active version, all versions, and description. Use this to discover what workflows already exist before creating a new one or referencing one in a subflow.",
      inputSchema: z.object({}),
      execute: async () => {
        const workflows = await deps.workspace.listWorkflows();
        return { workflows };
      },
    }),

    get_workflow: tool({
      description:
        "Get a published workflow's full YAML source plus its version metadata. Defaults to the active version; pass `version` for a specific one. Use this to read an existing workflow before editing, referencing it in a subflow, or running it.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name"),
        version: z
          .string()
          .optional()
          .describe("Optional specific version. Defaults to the active version."),
      }),
      execute: async ({ name, version }) => {
        const entry = (await deps.workspace.listWorkflows()).find(
          (w) => w.name === name,
        );
        if (!entry) {
          return { error: `Workflow "${name}" not found` };
        }
        const resolved = version ?? entry.activeVersion;
        let yaml;
        try {
          yaml = await deps.workspace.getWorkflowSource(name, resolved);
        } catch (err) {
          return {
            error: `Version "${resolved}" not found for "${name}". Available: ${entry.versions.join(", ")}`,
          };
        }
        return {
          name,
          version: resolved,
          activeVersion: entry.activeVersion,
          versions: entry.versions,
          description: entry.description,
          yaml,
        };
      },
    }),

    run_workflow: tool({
      description:
        "Run a published workflow with a given input and return the result. Use this to test workflows you just created. Returns status (success/error), output (on success), error details (on failure), and the runId. " +
        "Long runs AUTO-DETACH: if the run is still executing after the wait window, this returns { status: 'running', detached: true, runId } and the run continues in the background — when it finishes, a [run-notification] user message starts your next turn with the outcome. Do NOT poll get_run in a loop while waiting; finish your turn normally.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name to run"),
        input: z
          .any()
          .optional()
          .describe(
            "Input passed to the workflow as a JSON OBJECT (not a string), referenced in step configs via {{ input.* }} — the run subject, e.g. { owner, repo, pull_number }. Use {} if none.",
          ),
        params: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "Optional overrides for the workflow's `params` knobs (prompts, thresholds, sample sizes). Shallow-merged over the workflow's `params` defaults — set just the knobs you want to vary for this trial. Referenced in step configs via {{ params.* }}.",
          ),
        version: z
          .string()
          .optional()
          .describe("Optional specific version. Defaults to the active version."),
      }),
      execute: async ({ name, input, params, version }) => {
        let flow;
        try {
          flow = version
            ? await deps.workspace.getWorkflowVersion(name, version)
            : await deps.workspace.getWorkflow(name);
        } catch (err) {
          return {
            ok: false,
            error: `Workflow not found: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Generate the runId here (not in the runner) so the detached stub
        // can report it before the run finishes.
        const runId = generateRunId();
        const startedAt = Date.now();
        // Register with the host's controller registry (when wired) so the
        // run is cancellable/pausable and lists as live from launch.
        const tracked = deps.trackRun?.(name, runId);
        // This chat wants the verdict: the verify pass that follows the run
        // wakes it with a [verify-notification].
        if (verifier) deps.watchVerify?.(runId);
        const contract = await pendingContract(flow, name);
        const promise = runWorkflow(flow, coerceJsonArg(input) ?? {}, deps.registry, {
          runId,
          store: deps.store,
          workspace: deps.workspace,
          services: deps.services,
          params: coerceJsonArg(params) as Record<string, unknown> | undefined,
          controller: tracked?.controller,
          workflowHash:
            (await deps.workspace.getWorkflowHash(name, version)) ?? undefined,
          stepHashes: await stepHashesFor(deps.workspace, flow),
        }).finally(() => tracked?.untrack());

        // No detach seam (tests / non-chat embedders) → await as before.
        const detach = deps.detach;
        if (!detach) return { ...(await promise), ...contract };

        // Dispatch mode: race the run against the wait window. Fast runs
        // return synchronously (the quick inner-loop path); a run that
        // outlives the window converts to detached — the host takes the
        // pending promise and wakes the chat when it settles.
        const pending = Symbol("pending");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const winner = await Promise.race([
          promise,
          new Promise<typeof pending>((res) => {
            timer = setTimeout(() => res(pending), detach.waitMs);
          }),
        ]).finally(() => clearTimeout(timer));
        if (winner !== pending) return { ...winner, ...contract };

        detach.onDetach({ workflow: name, runId, startedAt, promise });
        return {
          status: "running",
          detached: true,
          runId,
          ...contract,
          workflow: name,
          note:
            `Run still executing after ${Math.round(detach.waitMs / 1000)}s — it continues detached in the background. ` +
            "When it finishes, a [run-notification] message will start your next turn with the result. " +
            "Do NOT poll get_run in a loop; finish this turn normally (note anything you'll need when the result arrives).",
        };
      },
    }),

    run_step: tool({
      description:
        "Run a SINGLE step in isolation with a given config + input, and return its output + events — WITHOUT wiring it into a workflow. This is the inner loop for authoring an adapter: create_step → run_step → edit_step → run_step until the output is right. " +
        "Set cassette:'record' to run live AND capture the step's external service calls (http, etc.) to a reusable fixture (secrets are scrubbed); then cassette:'replay' to iterate OFFLINE against that fixture — deterministic, no rate limits, no cost, no side effects (so you don't, e.g., create a real charge on every test). " +
        "Returns { runId, status, output?, error?, events, recorded?, kept? } — `kept` is the run-store key (`step:<type>`) when the run was persisted.",
      inputSchema: z.object({
        type: z.string().describe("Step type to run, e.g. 'stripe/list-charges' or 'http'."),
        config: z
          .record(z.string(), z.any())
          .optional()
          .describe("The step's config (same shape as in a workflow). Templates like {{ input.* }} / {{ params.* }} are resolved."),
        input: z
          .any()
          .optional()
          .describe("Workflow input object, referenced in config via {{ input.* }}."),
        params: z
          .record(z.string(), z.any())
          .optional()
          .describe("Params knobs, referenced via {{ params.* }}."),
        cassette: z
          .enum(["record", "replay"])
          .optional()
          .describe("record: run live + capture external calls to a fixture. replay: serve them from the fixture (offline). Omit for a plain live run."),
        cassetteName: z
          .string()
          .optional()
          .describe("Fixture name (defaults to the step type). Use distinct names to keep multiple scenarios per step."),
        keep: z.boolean().optional().describe('Persist this run under the run-store key `step:<type>` (read it back with list_runs / get_run on that key). Runs of a step that has claims are kept automatically — they can become evidence; set this to keep a run of a step that has none.'),
      }),
      execute: async ({ type, config, input, params, cassette, cassetteName, keep }) => {
        const registry = deps.registry;
        if (!registry[type]) return { error: `Step type "${type}" not found` };
        if (cassette && !deps.dataDir) {
          return { error: "Cassette record/replay is unavailable (no local data dir configured)." };
        }
        const result = await runStep(
          type,
          registry,
          deps.services,
          {
            config: coerceJsonArg(config) as Record<string, unknown> | undefined,
            input: coerceJsonArg(input),
            params: coerceJsonArg(params) as Record<string, unknown> | undefined,
            workspace: deps.workspace,
            keep: keep === true,
            ...(cassette
              ? { cassette: { mode: cassette, path: cassettePath(deps.dataDir!, cassetteName ?? type) } }
              : {}),
          },
          {
            store: deps.store,
            workspace: deps.workspace,
            claims: claims?.reader ?? null,
            onKept: (key, runId) => {
              if (verifier) deps.watchVerify?.(runId);
              verifier?.schedule(key, runId);
            },
          },
        );
        // A kept run is being verified: show the step's contract, pending.
        return result.kept ? { ...result, ...(await pendingContract({ name: type, steps: [{ id: "step", type, config: {} }] })) } : result;
      },
    }),

    list_runs: tool({
      description:
        "List past runs of a workflow (newest first), each with its status, duration, and timestamps. Use this to inspect a workflow's run history — e.g. to compare experiment runs or find a failing run. Then call get_run for a specific run's full input/output/events.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name whose runs to list"),
        limit: z
          .number()
          .int()
          .positive()
          .default(20)
          .describe("Max number of recent runs to return (default 20)."),
      }),
      execute: async ({ name, limit }) => {
        return { workflow: name, runs: await listRunSummaries(deps.store, name, limit) };
      },
    }),

    get_run: tool({
      description:
        "Get a single run's details: its summary (input, output, status, error, duration) and its event log. By default the event log is slimmed (type/path/duration/error per step, no payloads) to stay token-cheap; set fullEvents:true to include each step's input/output. Use this to debug why a run failed or to read what each step produced.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name"),
        runId: z.string().describe("Run id (a millisecond timestamp, from list_runs)"),
        fullEvents: z
          .boolean()
          .default(false)
          .describe("Include full per-step input/output payloads in events (default false: slimmed)."),
      }),
      execute: async ({ name, runId, fullEvents }) => {
        return readRun(deps.store, name, runId, fullEvents);
      },
    }),

    search_runs: tool({
      description:
        "Grep across a workflow's recent runs: match a regex against every event's JSON (inputs, outputs, errors) and get back (runId, event path, snippet) tuples plus a per-run frequency summary. The cross-run complement to get_run — use it to answer 'which runs hit this, and how often?' (e.g. a recurring error signature across a batch), then get_run to investigate one run. Note: tool outputs are truncated in the event log (~1500 chars), so a signature deep in long output can be missed.",
      inputSchema: z.object({
        name: z.string().describe("Workflow name whose runs to search"),
        pattern: z
          .string()
          .describe(
            "JavaScript regular expression matched against each event's JSON line, e.g. \"command not found|ModuleNotFoundError\".",
          ),
        runIds: z
          .array(z.string())
          .optional()
          .describe("Explicit run ids to search. Default: the newest runLimit runs."),
        runLimit: z
          .number()
          .int()
          .positive()
          .default(20)
          .describe("How many recent runs to scan when runIds is absent (default 20)."),
        maxMatches: z
          .number()
          .int()
          .positive()
          .default(50)
          .describe(
            "Cap on returned matches; scanning stops once reached (truncated: true). Narrow the pattern or run window rather than raising this (default 50).",
          ),
        ignoreCase: z.boolean().default(true).describe("Case-insensitive matching (default true)."),
      }),
      execute: async ({ name, pattern, runIds, runLimit, maxMatches, ignoreCase }) => {
        return searchRunEvents(deps.store, name, pattern, { runIds, runLimit, maxMatches, ignoreCase });
      },
    }),

    // Run control — only when the host wires `deps.controlRun` (the standard
    // server does): the builder can stop/park a live run it launched, not
    // just launch it. Same code path as the HTTP control endpoints.
    ...(deps.controlRun ? runControlTools(deps.controlRun) : {}),

    // Build-time shell — only offered when the host wires `deps.shell` (the
    // standard server does; embedders/tests without it get no bash tool).
    ...(deps.shell
      ? {
          bash: tool({
            description:
              "Execute a bash command in the server's data directory — for BUILD-TIME exploration while authoring: curl an API to see its real response shape before writing a step, clone a repo into scratch/ to inspect a data format, check a CLI exists, read a run's file outputs under artifacts/<runId>/. Commands run under a scrubbed environment (no server API keys — use placeholder values when probing an authed API, or author the step and run_step it with the real secret). This tool is NOT how production workflows reach the outside world: steps you author must still use ctx.services.http + ctx.services.secrets so runs stay recordable and secrets scrubbed. Output is captured with a cap; default timeout 30s (raise timeoutMs up to 10 min for clones/installs).",
            inputSchema: z.object({
              command: z.string().describe("The bash command to execute"),
              timeoutMs: z
                .number()
                .int()
                .positive()
                .max(600_000)
                .default(30_000)
                .describe("Kill the command after this long (default 30s, max 10 min)."),
            }),
            execute: async ({ command, timeoutMs }) => {
              const { cwd } = deps.shell!;
              try {
                // Lazy so embedders that never call bash don't load the module.
                const { runShell } = await import("../shell.js");
                const { mkdir } = await import("node:fs/promises");
                const { join } = await import("node:path");
                // scratch/ always exists — the advertised home for clones and
                // experiments, so they never land among workspace internals.
                await mkdir(join(cwd, "scratch"), { recursive: true });
                return { output: await runShell(command, cwd, timeoutMs, 20_000) };
              } catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
              }
            },
          }),
        }
      : {}),

    // Read-only raw Cypher — only when the host wires a graph backend
    // (`deps.graph`). The builder's verification loop for graph-writing
    // workflows; see graph/query.ts for why it is read-only and capped, and
    // why it is a chat tool rather than a step.
    ...(deps.graph
      ? {
          graph_query: tool({
            description:
              "Run a READ-ONLY Cypher query against the strut graph (Neo4j) and get rows back. Use it to VERIFY what a workflow's graph/* steps actually wrote — count nodes/edges by type, read back exact properties, check edge fan-out — or to inspect graph-backed workspace state. " +
              "Writes (CREATE/MERGE/SET/DELETE/…, apoc.*) are rejected; write through the graph/* steps. " +
              `Conventions: every node has its type as a label plus :Node:Data_Bank and the properties {ref_id, node_key, namespace}; the deployment's default namespace is "${deps.graph.cfg.namespace}" — filter on it (n.namespace = $ns) so you don't read across partitions. Edge types are UPPER_SNAKE. ` +
              "Output is capped: rows (default 100), long strings truncated, embedding vectors collapsed. Prefer aggregates (count, collect(DISTINCT …)) and LIMIT over dumping nodes. " +
              "Returns { columns, rows, rowCount, truncated, elapsedMs } or { error }.",
            inputSchema: z.object({
              cypher: z.string().describe("A read-only Cypher query, e.g. \"MATCH (n:Concept {namespace: $ns}) RETURN count(n) AS n\"."),
              params: z
                .record(z.string(), z.any())
                .optional()
                .describe("Query parameters referenced as $name in the cypher, e.g. { ns: \"default\" }. Prefer params over string interpolation."),
              maxRows: z
                .number()
                .int()
                .positive()
                .max(1000)
                .default(100)
                .describe("Row cap (default 100, max 1000). When exceeded, truncated:true — narrow the query rather than raising this."),
            }),
            execute: async ({ cypher, params, maxRows }) => {
              try {
                // Lazy so embedders that never call it don't load neo4j-driver here.
                const { readQuery } = await import("../graph/query.js");
                return await readQuery(deps.graph!, cypher, {
                  params: coerceJsonArg(params) as Record<string, unknown> | undefined,
                  maxRows,
                });
              } catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
              }
            },
          }),
        }
      : {}),

    // graph_walk: the graph/walk step as a chat tool, streaming each hop as a
    // preliminary result (walk-tool.ts). Same gate as graph_query.
    ...(deps.graph
      ? {
          graph_walk: graphWalkTool({
            reader: deps.graph.reader,
            // As graph/walk's run(): jev when TYPESAFE_AI_API_KEY is set, else
            // the deployment's language model — keys via the secrets capability.
            evaluate:
              deps.walkEvaluate ??
              (async ({ model, abortSignal }) => {
                const em = await resolveEvaluationModel({
                  model,
                  secrets: (deps.services as { secrets?: NonNullable<Parameters<typeof resolveEvaluationModel>[0]>["secrets"] } | undefined)?.secrets,
                  fallback: { model: process.env["STRUT_LLM_MODEL"], provider: process.env["STRUT_LLM_PROVIDER"] },
                });
                return { evaluate: modelEvaluate(em.model, { abortSignal }), name: em.name };
              }),
          }),
        }
      : {}),

    // web_search + web_fetch (the same pair the agent step ships) — for
    // reading API docs while authoring adapters. Built by the host per turn
    // for the chat's provider (createWebTools); absent → not offered.
    ...((deps.webTools ?? {}) as Record<string, any>),
  };
}
