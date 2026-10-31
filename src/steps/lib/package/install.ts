import { z } from "zod";
import type { CardField } from "../../../core.js";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { PACKAGE_NAME } from "../../../packages/format.js";

/**
 * An AGENT asks to install a package; a PERSON says yes (plans/marketplace.md
 * §8, ruled 2026-10-29). Installing is running someone else's TypeScript in
 * this process, so the step runs ONLY as a proposal a person accepted
 * (`ctx.proposal`), as `app/grant` does: a direct tool call, a DAG step,
 * `meta/run-step` or a subflow is refused, and the capability behind it
 * (`ctx.services.packages.install`, createStrut) checks the accepted record
 * on disk for this very ref, so a forged context opens nothing. The seeds
 * that grant it list it in `approve:`; a host's delta may add it to others.
 *
 * The CARD is the ask §8 designed: `describe` runs at proposal time and
 * reads the package's page off the index this strut follows (the hit's
 * `detail`, derived by the index from the archive — src/packages/detail.ts):
 * the publisher and its key, which index vouches for the pair, the digest,
 * the license, what it brings, what it can spend or act on (the §8 lines,
 * read off the closure by the index), what it needs. Nothing is fetched
 * from the publisher before the yes; the install then re-verifies
 * everything against the publisher's own catalog.
 */

const PK_REF = /^pk:[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*(?:@sha256:[0-9a-f]{64})?$/;

const input = z.object({
  package: z
    .string()
    .min(1)
    .describe("The package by name, `publisher/name` (looked up in the indexes this strut follows), or a `pk:<key>/<publisher>/<name>` ref with its `url`."),
  index: z.string().optional().describe("Which followed index to resolve the name through, when more than one lists its publisher."),
  digest: z.string().optional().describe("`sha256:<hex>`: pin this release; else the newest not yanked."),
  url: z.string().optional().describe("With a `pk:` ref: where the publisher's public catalog is served."),
});

const words = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export default defineStep({
  type: "package/install",
  effect: "write",
  description:
    "Install a package — the workflows, steps, apps and Concept pages someone published — on this strut, on the person's yes. " +
    "The call becomes a proposal the person approves on a card that says what the package brings, what it can spend or act on, and which secrets it needs; " +
    "strut installs it when they accept, and tells you the result on a later turn. Find the name with package/search first (its `detail` says what a package holds) " +
    "and put the reason in `rationale`, in the person's terms. Never installs on its own: a direct call is refused.",
  input,
  output: z.any(),
  async describe(cfg, ctx: StepContext<StrutCapabilities>) {
    const name = cfg.package.startsWith("pk:") ? cfg.package.slice(3).split("/").slice(1, 3).join("/") : cfg.package;
    const title = `Install the package ${name}`;
    const cap = ctx.services?.packages;
    if (!cap || !PACKAGE_NAME.test(name)) return { title };
    const found = await cap.search(name, { limit: 50 }).catch(() => null);
    const hit = found?.packages.find((h) => h.package === name && (!cfg.index || h.index === cfg.index) && (!cfg.digest || h.digest === cfg.digest));
    if (!hit) {
      return {
        title,
        summary:
          `${name} is not listed by an index this strut follows` +
          (cfg.package.startsWith("pk:") ? `; it would be fetched by its publisher's key from ${cfg.url ?? "the catalog URL given"}.` : ".") +
          " What it holds is not known before the install, which checks every file against the publisher's signed catalog.",
      };
    }
    const d = hit.detail;
    const lines: string[] = [];
    lines.push(`${hit.package} ${hit.version}${hit.license ? ` (${hit.license})` : " (no license named)"} from ${hit.publisher} — key ${hit.key.slice(0, 8)}…${hit.key.slice(-6)}, listed by the index ${hit.index}; digest ${hit.digest.replace(/^sha256:/, "").slice(0, 12)}.`);
    if (d) {
      const holds = [
        d.apps.length ? `${words(d.apps.length, "app")} (${d.apps.map((a) => a.title).join(", ")})` : "",
        d.workflows ? words(d.workflows, "workflow") : "",
        d.steps ? `${words(d.steps, "step")} — TypeScript that runs inside this strut` : "",
        d.concepts ? words(d.concepts, "Concept page") : "",
      ].filter(Boolean);
      lines.push(`It brings ${holds.length ? holds.join(", ") : "nothing the index could read"}.`);
      const can: string[] = [];
      if (d.can.spends) can.push("spend (a model is called)");
      if (d.can.acts) can.push("act (a step changes something outside the run)");
      if (d.can.code) can.push("run code (its own TypeScript, or exec)");
      lines.push(can.length ? `It can ${can.join("; ")}.` : "It only reads: no model call, no step that acts, no code of its own.");
      lines.push(d.secrets.length ? `It needs the secret${d.secrets.length === 1 ? "" : "s"} ${d.secrets.join(", ")}.` : "It needs no secret.");
    } else {
      lines.push("The index has not read its archive yet, so what it holds is not known before the install.");
    }
    const req = hit.requires;
    if (req?.packages?.length) lines.push(`It installs ${req.packages.map((p) => p.package).join(", ")} with it.`);
    if (req?.binaries?.length || req?.runtimes?.length) lines.push(`It needs on this machine: ${[...(req.binaries ?? []), ...(req.runtimes ?? [])].join(", ")}.`);
    lines.push("Read off the index's copy, unsigned; the install re-verifies every file against the publisher's own catalog, and the key above is pinned.");
    const fields: CardField[] = [
      { label: "Version and license", value: `${hit.package} ${hit.version}${hit.license ? ` (${hit.license})` : " (no license named)"}` },
      { label: "Publisher key", value: `${hit.publisher} — ${hit.key.slice(0, 8)}…${hit.key.slice(-6)}`, kind: "ref" },
    ];
    if (d) {
      const holds = [
        d.apps.length ? words(d.apps.length, "app") : "",
        d.workflows ? words(d.workflows, "workflow") : "",
        d.steps ? words(d.steps, "step") : "",
        d.concepts ? words(d.concepts, "Concept page") : "",
      ].filter(Boolean);
      fields.push({ label: "Brings", value: holds.join(", ") || "nothing the index could read" });
      fields.push({ label: "Needs", value: d.secrets.length ? d.secrets.join(", ") : "no secret" });
      fields.push({ label: "Runs code", value: d.can.code ? "yes" : "no", ...(d.can.code ? { danger: true } : {}) });
    }
    return { title, summary: lines.join(" "), fields, actions: { accept: "Install", reject: "Don't install" }, full: !!d };
  },
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    if (!ctx.proposal) {
      throw new Error(
        "package/install runs only as a proposal a person accepted: installing puts someone's code in this strut, and a person decides that, never a tool call. " +
          "Ask for it as a tool call the person approves (the agent's approve: list names it); a workflow step, meta/run-step or a subflow cannot reach it.",
      );
    }
    const door = ctx.services?.packages?.install;
    if (!door) throw new Error("package/install needs strut's package door (ctx.services.packages.install); the standard strut server provides it.");
    if (!PACKAGE_NAME.test(cfg.package) && !PK_REF.test(cfg.package)) {
      throw new Error(`package_source_invalid: ${cfg.package} is neither a name (publisher/name) nor a pk:<key>/<publisher>/<name> ref — a person installs from a file or a repository through the Packages dialog`);
    }
    return door(cfg.package, {
      proposal: ctx.proposal.id,
      ...(cfg.index ? { index: cfg.index } : {}),
      ...(cfg.digest ? { digest: cfg.digest } : {}),
      ...(cfg.url ? { url: cfg.url } : {}),
      ...(ctx.actor ? { actor: ctx.actor } : {}),
    });
  },
});
