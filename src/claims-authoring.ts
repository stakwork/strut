/**
 * Claim + check authoring — one policy layer behind BOTH doors
 * (`plans/claims.md` §2): the chat builder's tools and the `meta/*` twins an
 * in-workflow author gets. `graph/claims-writer.ts` keeps the graph's
 * invariants; this decides what a given AUTHOR may write:
 *
 *   - a check spec is validated before anything is written: the step type
 *     exists, the config is JSON, enums and ranges hold, an external check
 *     says what to look at;
 *   - defaults are applied at write time, so the node is self-describing:
 *     `run_when: run`; `policy: always` for a code check, `on_change` for
 *     one PRESUMED PAID (an `agent` / `llm` step anywhere in the check
 *     closure, or a closure that cannot be resolved) and for an external
 *     check, where it paces the question (a person's time is the cost);
 *   - FIXED POINT 1 — a `scoped` actor (the meta surface) edits, retires and
 *     detaches only claims it stamped (`Claim.speaker_name`) and checks it
 *     stamped (`Check.publisher`), may ADD a check only to a claim it
 *     stamped, and may attach claims only to subjects it published. An
 *     always-passing check hung on a seeded contract line would otherwise
 *     read as `supported` whenever the real check was skipped;
 *   - FIXED POINT 2 — a check stamped `ai` may not reach a grader: no
 *     harness-only step type (`gaia/*`, `harvey/*`, `eval/*`, `meta/*`, plus
 *     `STRUT_VERIFY_DENY`) anywhere in the check CLOSURE — named, nested in
 *     a subflow child, or granted to an agent — and an unresolvable closure
 *     is refused. Enforced here at write; the verify pass enforces it again
 *     at run time, because a subflow child can be republished afterwards.
 *
 * Every method returns a plain result (`{ ok: true, … }` or `{ error }`) —
 * the shape the tool layer hands to a model.
 */
import yaml from "js-yaml";
import { closureIncludes, flowClosure, globToRegExp, type FlowClosure } from "./closure.js";
import { validateWorkflowYaml } from "./validate.js";
import type { StepRegistry } from "./core.js";
import type { GraphBackend } from "./graph/backend.js";
import { ClaimsReader, isExternalCheck, type CheckPolicy, type CheckRow, type ClaimStatus, type RunWhen, type SubjectRef } from "./graph/claims.js";
import { ClaimsError, ClaimsWriter, boundedName, type CheckData } from "./graph/claims-writer.js";
import type { WorkspaceStore } from "./workspace.js";

// ── Inputs (the tool-facing shapes) ─────────────────────────────────────────

/** A subject as a tool names it. */
export interface SubjectInput {
  kind: "step" | "workflow";
  /** Workflow name, or custom step type. */
  name: string;
}

/**
 * One check. A STEP check names a registry step (`type` + `config`); the
 * subject is that step's run input, so config templates read
 * `{{ input.output.* }}` / `{{ input.input.* }}`. An EXTERNAL check has no
 * `type` — only a `description` of what to look at and why code cannot.
 */
export interface CheckSpecInput {
  type?: string;
  config?: Record<string, unknown>;
  name?: string;
  description?: string;
  when?: RunWhen;
  policy?: CheckPolicy;
  freshnessDays?: number;
  sampleRate?: number;
}

export interface ClaimSpecInput {
  text: string;
  checks: CheckSpecInput[];
}

/** Who is writing. `scoped` = the meta surface: only what it stamped. */
export interface ClaimActor {
  publisher: string;
  scoped: boolean;
}

export type ClaimsResult<T> = ({ ok: true } & T) | { error: string };

export interface ClaimsAuthoringDeps {
  graph: GraphBackend;
  workspace: WorkspaceStore;
  /** FRESH registry — a check may name a step published this turn. */
  getRegistry(): Promise<StepRegistry>;
  env?: Record<string, string | undefined>;
}

/** The stamp fixed point 2 keys on (`authoring.ts` `AI_PUBLISHER`). */
const AI_STAMP = "ai";
const RUN_WHENS: readonly RunWhen[] = ["run", "publish"];
const POLICIES: readonly CheckPolicy[] = ["always", "on_change", "sample", "manual"];
const PAID_STEP_TYPES = ["agent", "llm"];

/** Harness-only namespaces a producer-visible check must never reach. */
export const DEFAULT_VERIFY_DENY = ["gaia/*", "harvey/*", "eval/*", "meta/*"];

export function verifyDenyPatterns(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env["STRUT_VERIFY_DENY"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_VERIFY_DENY, ...extra])];
}

/**
 * The first grader a check closure reaches, or null. A step type is checked
 * by name; an `agentTools` grant is checked both literally (`"gaia/*"`) and
 * expanded over the registry (`"*"` reaches `gaia/evaluate`).
 */
export function deniedInClosure(closure: FlowClosure, deny: readonly string[], registryTypes: readonly string[]): string | null {
  const res = deny.map((p) => ({ p, re: globToRegExp(p) }));
  const hit = (type: string) => res.find((d) => d.re.test(type));
  for (const t of closure.types) if (hit(t)) return t;
  for (const grant of closure.agentTools) {
    if (hit(grant) || res.some((d) => d.p === grant)) return grant;
    if (!grant.includes("*")) continue;
    const re = globToRegExp(grant);
    const reached = registryTypes.find((t) => re.test(t) && hit(t));
    if (reached) return `${grant} (reaches ${reached})`;
  }
  return null;
}

export function toSubjectRef(s: SubjectInput): SubjectRef {
  return s.kind === "workflow" ? { kind: "workflow", name: s.name } : { kind: "step", type: s.name };
}

const fail = (e: unknown): { error: string } => {
  if (e instanceof ClaimsError) return { error: e.message };
  return { error: e instanceof Error ? e.message : String(e) };
};

export interface ClaimListing {
  id: string;
  text: string;
  speaker?: string;
  status: ClaimStatus["status"];
  assertedOnly: boolean;
  unverified: number;
  openSlot: boolean;
  checks: Array<{
    id: string;
    name: string;
    external: boolean;
    type?: string;
    config?: unknown;
    description?: string;
    when?: string;
    policy?: string;
    freshnessDays?: number;
    sampleRate?: number;
    publisher?: string;
  }>;
}

export type ClaimsAuthoring = ReturnType<typeof buildClaimsAuthoring>;

export function buildClaimsAuthoring(deps: ClaimsAuthoringDeps) {
  const reader = new ClaimsReader(deps.graph);
  const writer = new ClaimsWriter(deps.graph, reader);
  const deny = () => verifyDenyPatterns(deps.env ?? process.env);

  /** Validate one spec and apply the write-time defaults. Throws ClaimsError. */
  async function normalizeCheck(spec: CheckSpecInput, actor: ClaimActor, where: string): Promise<CheckData> {
    if (!spec || typeof spec !== "object") throw new ClaimsError("INVALID", `${where}: a check is an object — { type, config } for a step check, { description } for an external one`);
    const when = spec.when ?? "run";
    if (!RUN_WHENS.includes(when)) throw new ClaimsError("INVALID", `${where}: when must be one of ${RUN_WHENS.join(" | ")}`);
    if (spec.policy !== undefined && !POLICIES.includes(spec.policy)) throw new ClaimsError("INVALID", `${where}: policy must be one of ${POLICIES.join(" | ")}`);
    if (spec.freshnessDays !== undefined && !(Number.isInteger(spec.freshnessDays) && spec.freshnessDays > 0)) {
      throw new ClaimsError("INVALID", `${where}: freshnessDays must be a positive integer`);
    }
    if (spec.sampleRate !== undefined && !(typeof spec.sampleRate === "number" && spec.sampleRate > 0 && spec.sampleRate <= 1)) {
      throw new ClaimsError("INVALID", `${where}: sampleRate must be in (0, 1]`);
    }
    if (spec.policy === "sample" && spec.sampleRate === undefined) throw new ClaimsError("INVALID", `${where}: policy "sample" needs a sampleRate`);
    const common = {
      run_when: when,
      ...(spec.freshnessDays !== undefined ? { freshness_days: spec.freshnessDays } : {}),
      ...(spec.sampleRate !== undefined ? { sample_rate: spec.sampleRate } : {}),
      publisher: actor.publisher,
    };

    // External: answered by a person or an outside system through a slot.
    if (!spec.type) {
      const description = spec.description?.trim();
      if (!description) {
        throw new ClaimsError("INVALID", `${where}: give a step check a \`type\` (+ config), or an external check a \`description\` saying what to look at and why code cannot check it`);
      }
      if (spec.config !== undefined) throw new ClaimsError("INVALID", `${where}: \`config\` without a \`type\` — name the step that runs it`);
      if (when === "publish") throw new ClaimsError("INVALID", `${where}: an external check cannot run at publish (there is no run to look at)`);
      return { ...common, name: spec.name?.trim() || boundedName(description).slice(0, 60), description, policy: spec.policy ?? "on_change" };
    }

    const registry = await deps.getRegistry();
    if (!registry[spec.type]) throw new ClaimsError("INVALID", `${where}: step type "${spec.type}" not found — a check names a registry step (exec, llm, agent, subflow, or a custom step)`);
    const config = spec.config ?? {};
    if (typeof config !== "object" || Array.isArray(config)) throw new ClaimsError("INVALID", `${where}: config must be an object`);
    let step_config: string;
    try {
      step_config = JSON.stringify(config);
    } catch {
      throw new ClaimsError("INVALID", `${where}: config is not JSON-serializable`);
    }

    const closure = await flowClosure({ steps: [{ id: "check", type: spec.type, config }] }, deps.workspace);
    if (actor.publisher === AI_STAMP) {
      if (!closure.resolvable) {
        throw new ClaimsError("REFUSED", `${where}: this check's closure cannot be resolved (a subflow with a templated or missing \`workflow\`/\`version\`, or templated agentTools) — a check must name exactly what it runs`);
      }
      const grader = deniedInClosure(closure, deny(), Object.keys(registry));
      if (grader) {
        throw new ClaimsError("REFUSED", `${where}: a check may not reach a harness-only step (${grader}) — a contract the producer can see must never embed its grader`);
      }
    }
    // The same static check a workflow gets — a check IS a one-step flow whose
    // input is the subject, so `{{ input.* }}` is the only root it can read.
    // Catching a mistyped config here beats a check that silently never runs.
    const workflows = await deps.workspace.listWorkflows().catch(() => []);
    const v = validateWorkflowYaml(yaml.dump({ name: "check", steps: [{ id: "check", type: spec.type, config }] }), {
      registry,
      workflows: workflows.map((w) => ({ name: w.name, versions: w.versions })),
      name: "check",
    });
    if (!v.ok) {
      const list = v.errors.map((e) => `${e.path.replace(/^steps\[0\]\.?/, "") || "check"}: ${e.message}`).join("; ");
      throw new ClaimsError("INVALID", `${where}: the check's config is not valid for step "${spec.type}" — ${list}. (get_step("${spec.type}") shows its config.)`);
    }

    const presumedPaid = !closure.resolvable || PAID_STEP_TYPES.some((t) => closureIncludes(closure, t));
    return {
      ...common,
      name: spec.name?.trim() || spec.type,
      ...(spec.description?.trim() ? { description: spec.description.trim() } : {}),
      step_type: spec.type,
      step_config,
      policy: spec.policy ?? (presumedPaid ? "on_change" : "always"),
    };
  }

  async function normalizeClaims(claims: readonly ClaimSpecInput[], actor: ClaimActor): Promise<Array<{ text: string; checks: CheckData[] }>> {
    const out: Array<{ text: string; checks: CheckData[] }> = [];
    const seen = new Set<string>();
    for (const [i, c] of claims.entries()) {
      const text = typeof c?.text === "string" ? c.text.trim() : "";
      if (!text) throw new ClaimsError("INVALID", `claims[${i}]: text is empty`);
      if (seen.has(text)) throw new ClaimsError("INVALID", `claims[${i}]: the same text appears twice`);
      seen.add(text);
      if (!Array.isArray(c.checks) || c.checks.length === 0) {
        throw new ClaimsError("INVALID", `claims[${i}] ("${boundedName(text).slice(0, 60)}"): every claim needs at least one check — if code cannot check it, give it an external check ({ description })`);
      }
      const checks: CheckData[] = [];
      for (const [j, k] of c.checks.entries()) checks.push(await normalizeCheck(k, actor, `claims[${i}].checks[${j}]`));
      out.push({ text, checks });
    }
    return out;
  }

  /** Did `actor` publish this subject? (The meta surface's ownership rule.) */
  async function ownsSubject(subject: SubjectRef, actor: ClaimActor): Promise<boolean> {
    if (subject.kind === "step") return (await deps.workspace.listSteps({ publisher: actor.publisher })).some((s) => s.type === subject.type);
    return (await deps.workspace.getWorkflowMetadata(subject.name))?.publisher === actor.publisher;
  }

  async function requireOwnedSubjects(subjects: readonly SubjectRef[], actor: ClaimActor, verb: string): Promise<void> {
    if (!actor.scoped) return;
    for (const s of subjects) {
      if (!(await ownsSubject(s, actor))) {
        throw new ClaimsError("REFUSED", `${s.kind} "${s.kind === "step" ? s.type : s.name}" was not published by "${actor.publisher}" — the meta surface only ${verb} subjects it authored`);
      }
    }
  }

  async function requireOwnClaim(id: string, actor: ClaimActor, verb: string): Promise<void> {
    if (!actor.scoped) return;
    const claim = await reader.getClaim(id);
    if (claim && claim.speaker_name !== actor.publisher) {
      throw new ClaimsError("REFUSED", `claim "${id}" was written by "${claim.speaker_name ?? "someone else"}" — the meta surface only ${verb} claims it wrote. Add your own claim instead.`);
    }
  }

  async function requireOwnCheck(id: string, actor: ClaimActor, verb: string): Promise<CheckRow | null> {
    const check = await reader.getCheck(id);
    if (actor.scoped && check && check.publisher !== actor.publisher) {
      throw new ClaimsError("REFUSED", `check "${id}" was written by "${check.publisher ?? "someone else"}" — the meta surface only ${verb} checks it wrote`);
    }
    return check;
  }

  const listingOf = (k: CheckRow): ClaimListing["checks"][number] => {
    let config: unknown;
    if (k.step_config) {
      try {
        config = JSON.parse(k.step_config);
      } catch {
        config = k.step_config;
      }
    }
    return {
      id: k.id,
      name: k.name,
      external: isExternalCheck(k),
      ...(k.step_type ? { type: k.step_type } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(k.description ? { description: k.description } : {}),
      ...(k.run_when ? { when: k.run_when } : {}),
      ...(k.policy ? { policy: k.policy } : {}),
      ...(k.freshness_days !== undefined ? { freshnessDays: k.freshness_days } : {}),
      ...(k.sample_rate !== undefined ? { sampleRate: k.sample_rate } : {}),
      ...(k.publisher ? { publisher: k.publisher } : {}),
    };
  };

  return {
    reader,
    writer,

    /** Door one, part 1 — validate a publish tool's `claims` arg BEFORE the
     *  publish, so a broken contract blocks it the way a YAML error does. */
    async validateClaimsArg(claims: readonly ClaimSpecInput[] | undefined, actor: ClaimActor): Promise<{ error: string } | null> {
      if (!claims || claims.length === 0) return null;
      try {
        await normalizeClaims(claims, actor);
        return null;
      } catch (e) {
        return fail(e);
      }
    },

    /**
     * Door one, part 2 — after the publish. The arg only ever ADDS: a claim
     * whose text exactly matches an ACTIVE claim already about the subject
     * is skipped (a republish with the same arg is a no-op); it never edits,
     * retires or detaches. `count` is the subject's active claims afterwards
     * — zero carries a warning the author has to answer.
     */
    async applyClaimsArg(
      subject: SubjectInput,
      claims: readonly ClaimSpecInput[] | undefined,
      actor: ClaimActor,
    ): Promise<{ count: number; added: number; existing: number; warning?: string; error?: string }> {
      const ref = toSubjectRef(subject);
      let added = 0;
      let existing = 0;
      let error: string | undefined;
      try {
        const have = new Set((await reader.claimsFor(ref)).map((c) => c.claim_text));
        for (const c of await normalizeClaims(claims ?? [], actor)) {
          if (have.has(c.text)) {
            existing++;
            continue;
          }
          await writer.addClaim({ subjects: [ref], text: c.text, speaker: actor.publisher, checks: c.checks });
          added++;
        }
      } catch (e) {
        error = fail(e).error;
      }
      const count = (await reader.claimsFor(ref).catch(() => [])).length;
      return {
        count,
        added,
        existing,
        ...(error ? { error: `published, but writing claims failed: ${error}` } : {}),
        ...(count === 0 && !error
          ? { warning: `This ${subject.kind} has NO claims. State how it should behave — pass \`claims\` when publishing, or call add_claim — before you run it; a ${subject.kind} with no contract cannot be verified.` }
          : {}),
      };
    },

    async addClaim(input: { subjects: SubjectInput[]; text: string; checks: CheckSpecInput[] }, actor: ClaimActor): Promise<ClaimsResult<{ id: string; checks: string[] }>> {
      try {
        const subjects = (input.subjects ?? []).map(toSubjectRef);
        await requireOwnedSubjects(subjects, actor, "adds claims to");
        const [claim] = await normalizeClaims([{ text: input.text, checks: input.checks }], actor);
        return { ok: true, ...(await writer.addClaim({ subjects, text: claim!.text, speaker: actor.publisher, checks: claim!.checks })) };
      } catch (e) {
        return fail(e);
      }
    },

    async editClaim(id: string, text: string, actor: ClaimActor): Promise<ClaimsResult<{ id: string; superseded?: string; unchanged?: true }>> {
      try {
        await requireOwnClaim(id, actor, "edits");
        return { ok: true, ...(await writer.editClaim(id, text, actor.publisher)) };
      } catch (e) {
        return fail(e);
      }
    },

    async retireClaim(id: string, actor: ClaimActor): Promise<ClaimsResult<{ id: string }>> {
      try {
        await requireOwnClaim(id, actor, "retires");
        return { ok: true, ...(await writer.retireClaim(id)) };
      } catch (e) {
        return fail(e);
      }
    },

    async attachClaim(id: string, subject: SubjectInput, actor: ClaimActor): Promise<ClaimsResult<{ id: string; attached: boolean }>> {
      try {
        const ref = toSubjectRef(subject);
        await requireOwnedSubjects([ref], actor, "attaches claims to");
        return { ok: true, ...(await writer.attachClaim(id, ref)) };
      } catch (e) {
        return fail(e);
      }
    },

    async detachClaim(id: string, subject: SubjectInput, actor: ClaimActor): Promise<ClaimsResult<{ id: string; detached: boolean }>> {
      try {
        await requireOwnClaim(id, actor, "detaches");
        return { ok: true, ...(await writer.detachClaim(id, toSubjectRef(subject))) };
      } catch (e) {
        return fail(e);
      }
    },

    async addCheck(claimId: string, spec: CheckSpecInput, actor: ClaimActor): Promise<ClaimsResult<{ id: string }>> {
      try {
        await requireOwnClaim(claimId, actor, "adds checks to");
        return { ok: true, ...(await writer.addCheck(claimId, await normalizeCheck(spec, actor, "check"))) };
      } catch (e) {
        return fail(e);
      }
    },

    /** `patch` is merged over the check as it stands; the result is
     *  re-validated as a whole and written as a SUCCESSOR. */
    async editCheck(id: string, patch: CheckSpecInput, actor: ClaimActor): Promise<ClaimsResult<{ id: string; superseded?: string; unchanged?: true }>> {
      try {
        const old = await requireOwnCheck(id, actor, "edits");
        if (!old) throw new ClaimsError("NOT_FOUND", `check "${id}" not found`);
        const current = listingOf(old);
        const merged: CheckSpecInput = {
          type: current.type,
          config: current.config as Record<string, unknown> | undefined,
          name: current.name,
          description: current.description,
          when: current.when as RunWhen | undefined,
          policy: current.policy as CheckPolicy | undefined,
          freshnessDays: current.freshnessDays,
          sampleRate: current.sampleRate,
          ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        };
        const next = await normalizeCheck(merged, actor, "check");
        const same = (["name", "description", "step_type", "step_config", "run_when", "policy", "freshness_days", "sample_rate"] as const).every(
          (f) => (next[f] ?? undefined) === (old[f] ?? undefined),
        );
        if (same) return { ok: true, id, unchanged: true };
        return { ok: true, ...(await writer.editCheck(id, next)) };
      } catch (e) {
        return fail(e);
      }
    },

    async retireCheck(id: string, actor: ClaimActor): Promise<ClaimsResult<{ id: string }>> {
      try {
        await requireOwnCheck(id, actor, "retires");
        return { ok: true, ...(await writer.retireCheck(id)) };
      } catch (e) {
        return fail(e);
      }
    },

    /** A subject's active claims, each with its checks and computed status. */
    async listClaims(subject: SubjectInput): Promise<ClaimsResult<{ subject: SubjectInput; claims: ClaimListing[] }>> {
      try {
        const ref = toSubjectRef(subject);
        if (!(await reader.subjectRefId(ref))) throw new ClaimsError("NOT_FOUND", `${subject.kind} "${subject.name}" is not in the workspace`);
        const rows = await reader.statusFor(ref);
        return {
          ok: true,
          subject,
          claims: rows.map((r) => ({
            id: r.claim.id,
            text: r.claim.claim_text,
            ...(r.claim.speaker_name ? { speaker: r.claim.speaker_name } : {}),
            status: r.status.status,
            assertedOnly: r.status.assertedOnly,
            unverified: r.status.unverified,
            openSlot: r.status.openSlot,
            checks: r.checks.map(listingOf),
          })),
        };
      } catch (e) {
        return fail(e);
      }
    },
  };
}
