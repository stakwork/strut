/**
 * The Claims panel's HTTP door (`plans/claims.md` §2 "UI", §4.2) — onto the
 * same write the chat tools and the `meta/*` twins use.
 *
 * Whoever is at the keyboard is a PERSON: not publisher-scoped, and stamped
 * `person` — so an `ai` author can never edit what they wrote, and their
 * checks are not subject to the producer's grader deny-list. What a person
 * says about a run is still `asserted` evidence (`by: person`): a person
 * vouched, no instrument measured.
 *
 * Reads are open, like the rest of the read surface; every mutation is
 * behind `requireApiKey` (permissive in dev). Where the claims layer is off
 * (a filesystem workspace, or `STRUT_CLAIMS=0`) `GET /claims` answers
 * `{ enabled: false }` — the panel hides itself — and mutations answer 409.
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { requireApiKey } from "./auth.js";
import { toSubjectRef, type ClaimActor, type ClaimsAuthoring } from "./claims-authoring.js";
import { CLAIMS_OFF, checkSpecSchema, claimSpecSchema, subjectSchema } from "./claims-schemas.js";
import type { Verifier } from "./verify.js";

export interface ClaimsRoutesDeps {
  /** The claims layer, where it is on (see `StrutOptions.claims`). */
  claims: ClaimsAuthoring | null;
  verifier: Verifier | null;
}

/** The HTTP door's actor — a PERSON: unscoped, and stamped as one. Shared
 *  with the publish routes, which apply a YAML `claims:` block the same way. */
export const PERSON: ClaimActor = { publisher: "person", scoped: false };

export function claimsRoutes(app: Hono, deps: ClaimsRoutesDeps): void {
  const claims = deps.claims;

  /** Parse the JSON body with a zod shape; a 400 names what is wrong. */
  async function bodyOf<S extends z.ZodType>(c: Context, shape: S): Promise<{ data: z.infer<S> } | { error: string }> {
    const parsed = shape.safeParse(await c.req.json().catch(() => null));
    return parsed.success ? { data: parsed.data } : { error: `invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` };
  }
  /** Authoring results are `{ ok, … } | { error }` — an error is the caller's to fix. */
  const reply = (c: Context, result: unknown) => c.json(result as object, result && typeof result === "object" && "error" in result ? 400 : 200);
  const off = (c: Context) => c.json({ error: CLAIMS_OFF }, 409);
  const id = (c: Context) => c.req.param("id") ?? "";

  // A subject's contract: claims with computed status, latest evidence, their
  // checks, and open slots (questions an external check is waiting on).
  app.get("/claims", async (c) => {
    if (!claims) return c.json({ enabled: false, claims: [] });
    const subject = subjectSchema.safeParse({ kind: c.req.query("kind"), name: c.req.query("name") });
    if (!subject.success) return c.json({ error: "kind (step | workflow) and name are required" }, 400);
    const listing = await claims.listClaims(subject.data);
    // A built-in step has no node in the workspace: it simply has no contract.
    if (!("ok" in listing)) return c.json({ enabled: true, subject: subject.data, claims: [], note: listing.error });
    const verifyCostUsd = deps.verifier ? await deps.verifier.costOf(toSubjectRef(subject.data)).catch(() => 0) : 0;
    return c.json({ enabled: true, subject: listing.subject, claims: listing.claims, ...(verifyCostUsd > 0 ? { verifyCostUsd } : {}) });
  });

  app.post("/claims", requireApiKey, async (c) => {
    if (!claims) return off(c);
    const body = await bodyOf(c, claimSpecSchema.extend({ subjects: z.array(subjectSchema).min(1) }));
    if ("error" in body) return c.json(body, 400);
    return reply(c, await claims.addClaim(body.data, PERSON));
  });

  app.patch("/claims/:id", requireApiKey, async (c) => {
    if (!claims) return off(c);
    const body = await bodyOf(c, z.object({ text: z.string() }));
    if ("error" in body) return c.json(body, 400);
    return reply(c, await claims.editClaim(id(c), body.data.text, PERSON));
  });

  app.delete("/claims/:id", requireApiKey, async (c) => (claims ? reply(c, await claims.retireClaim(id(c), PERSON)) : off(c)));

  for (const verb of ["attach", "detach"] as const) {
    app.post(`/claims/:id/${verb}`, requireApiKey, async (c) => {
      if (!claims) return off(c);
      const body = await bodyOf(c, z.object({ subject: subjectSchema }));
      if ("error" in body) return c.json(body, 400);
      return reply(c, verb === "attach" ? await claims.attachClaim(id(c), body.data.subject, PERSON) : await claims.detachClaim(id(c), body.data.subject, PERSON));
    });
  }

  app.post("/claims/:id/checks", requireApiKey, async (c) => {
    if (!claims) return off(c);
    const body = await bodyOf(c, z.object({ check: checkSpecSchema }));
    if ("error" in body) return c.json(body, 400);
    return reply(c, await claims.addCheck(id(c), body.data.check, PERSON));
  });

  app.patch("/checks/:id", requireApiKey, async (c) => {
    if (!claims) return off(c);
    const body = await bodyOf(c, z.object({ patch: checkSpecSchema }));
    if ("error" in body) return c.json(body, 400);
    return reply(c, await claims.editCheck(id(c), body.data.patch, PERSON));
  });

  app.delete("/checks/:id", requireApiKey, async (c) => (claims ? reply(c, await claims.retireCheck(id(c), PERSON)) : off(c)));

  // A person's own observation on a run — and how an open slot is ANSWERED
  // from the panel (pass `slot`). Always `asserted`, `by: person`.
  app.post("/claims/:id/evidence", requireApiKey, async (c) => {
    if (!deps.verifier) return off(c);
    const body = await bodyOf(
      c,
      z.object({ name: z.string(), runId: z.string(), supports: z.boolean(), content: z.string(), slot: z.string().optional(), subject: subjectSchema.optional() }),
    );
    if ("error" in body) return c.json(body, 400);
    const { subject, slot, ...rest } = body.data;
    return reply(
      c,
      await deps.verifier.addEvidence({
        claim: id(c),
        ...rest,
        ...(slot ? { slot } : {}),
        ...(subject ? { subject: toSubjectRef(subject) } : {}),
        by: "person",
        mode: "asserted",
      }),
    );
  });
}
