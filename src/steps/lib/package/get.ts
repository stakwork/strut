import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { INSTALL_IS_A_PERSONS_ACT, README_BRIEF_CHARS, briefPackagePage } from "../../../packages/indexes.js";

/**
 * One package's PAGE from the store (plans/marketplace.md §7, the store
 * front; §8 on who installs): what `GET /index/packages/:publisher/:name`
 * serves on the index that lists its publisher, read through
 * `ctx.services.packages.get` (src/packages/indexes.ts). A read: the step
 * installs nothing, and its description says so to the model.
 */
export default defineStep({
  type: "package/get",
  effect: "read",
  description:
    "Read one PACKAGE's page from the store — the indexes this strut follows (the first whose card lists its publisher, or the one `index` names) — to see what it holds and does before recommending it or building the same thing. " +
    "Returns { package, publisher, key, urls, description?, releases (newest first), channels, readAt, detail?, detailError?, index }. `detail` is the newest release READ OFF ITS ARCHIVE: `apps` (title, grants, `can`), `workflows` (each with its `inputs`, the step types it runs, its `grants`, `secrets`, `can`, `claims`), `steps` (effect, the secrets they read, the lint's findings), `concepts` (name, description, parent — a page's docs through package/concepts), the README (cut at " +
    `${README_BRIEF_CHARS} chars unless \`full\`), the \`secrets\` the whole package needs, and \`can: { spends, acts, code }\` — whether running it reaches a model call (spends money), a step that acts on the world (effect: write), or code (exec, or the package's own TypeScript). ` +
    "`can` is a READING off the files — regexes over step sources, the YAML's step types — never a check or a sandbox; an install re-reads everything through the real parsers and re-verifies the package against its publisher's signed catalog. " +
    INSTALL_IS_A_PERSONS_ACT,
  input: z.object({
    package: z.string().describe("The package name, publisher/name (a hit's `package` from package/search)."),
    index: z.string().optional().describe("Read it from this followed index alone (its id, a hit's `index`)."),
    full: z.boolean().default(false).describe("The whole README and every Concept page's docs, for a workflow that wants them; default false — a page a model reads."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const cap = ctx.services?.packages;
    if (!cap?.get) throw new Error("package/get needs strut's package indexes (ctx.services.packages); the standard strut server provides them.");
    const page = await cap.get(cfg.package, cfg.index ? { index: cfg.index } : {});
    return cfg.full ? page : briefPackagePage(page);
  },
});
