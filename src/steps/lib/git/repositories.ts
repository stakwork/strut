import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { gitTokens, type StrutCapabilities } from "../../../capabilities.js";
import { forgeStepsOf, gitHostNames } from "../../../git-hosts.js";
import { boxHostsOf, callForgeStep, forgeRepository, repositoriesOutput } from "./_forge.js";

const EXAMPLE = `- id: repos
  type: git/repositories
  config: {}`;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 500);

/**
 * What the run's person's tokens reach, on every git host the box serves
 * (plans/package-seams.md §4): each host's `repositories` step — the one its
 * `provides.git` entry names — asked as the run's person. The caller names
 * no forge: a GitHub, GitLab or Forgejo package each fills it.
 */
export default defineStep({
  type: "git/repositories",
  effect: "read",
  description:
    `List the repositories the run's person's tokens reach, on every git host this server serves (or only \`host\`), so a caller names no forge. ` +
    `Each host's \`repositories\` step — named on its package's provides.git entry — is asked as the run's person, with the input { host }, and answers { repositories: [{ url, name, private?, pushed?, description?, picked? }] } (pushed: ISO 8601; picked: the person granted it one by one; other fields pass through). ` +
    `A host the person has no token for, that names no such step, or whose step fails, is listed with a \`problem\` instead of failing the call. ` +
    `Output: { repositories: [{ url, name, private?, pushed?, description?, picked? }], hosts: [{ host, problem? }] }.\n\n${EXAMPLE}`,
  input: z.object({
    host: z.string().min(1).optional().describe("one host (github.com, git.acme.com:3000); default every host this server serves"),
  }),
  output: z.object({
    repositories: z.array(forgeRepository),
    hosts: z.array(z.object({ host: z.string(), problem: z.string().optional() })),
  }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const all = boxHostsOf(ctx);
    const names = cfg.host ? [cfg.host.toLowerCase()] : gitHostNames(all);
    const tokenOf = gitTokens(ctx?.services?.secrets);
    const asked = await Promise.all(
      names.map(async (host): Promise<{ host: string; problem?: string; repositories?: z.infer<typeof forgeRepository>[] }> => {
        const entry = all.find((h) => h.host === host);
        if (!entry) return { host, problem: `this server serves no git host ${host}: a package that serves it says so in its provides.git` };
        const step = forgeStepsOf(all, host).repositories;
        if (!step) return { host, problem: `nothing here lists what a token for ${host} reaches: a package that serves it names a repositories step on its provides.git entry` };
        if (!(await tokenOf(`https://${host}/`).catch(() => undefined))) {
          return { host, problem: `no token for ${host}: set ${entry.secret}, your own or the server's` };
        }
        try {
          return { host, repositories: repositoriesOutput.parse(await callForgeStep(ctx, step, { host })).repositories };
        } catch (err) {
          return { host, problem: `${step}: ${errText(err)}` };
        }
      }),
    );
    return {
      repositories: asked.flatMap((a) => a.repositories ?? []),
      hosts: asked.map(({ host, problem }) => (problem ? { host, problem } : { host })),
    };
  },
});
