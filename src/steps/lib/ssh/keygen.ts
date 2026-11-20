import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { SecretsCapability } from "../../../capabilities.js";
import type { SecretBlanks } from "../../../secret-store.js";
import { newSshKey, SSH_KEY_SECRET, sshPublicKey } from "../../../ssh-agent.js";

/**
 * The public half of the SSH key a job's shell logs in with, made the first
 * time it is asked for. The private half is made and stored HERE, in code —
 * the run principal's own `SSH_KEY` (actor-secrets.ts), else the server's
 * when the run has no principal — and never returned: the model, the run's
 * events and the job's files only ever see the public half. The `agent`
 * step's `sshKeys` serves it to bash through an SSH agent (src/ssh-agent.ts).
 *
 * One key per person, kept and reused: an `SSH_KEY` the run already resolves
 * (the person's, else the server's) is the answer, never replaced. The
 * person's consent is adding the public half to a server; taking it out of
 * `authorized_keys` revokes it.
 */
export default defineStep({
  type: "ssh/keygen",
  effect: "write",
  description:
    "The public half of the SSH key your shell logs in with — made the first time you ask, the same one after that. Give it to the person to add as a line of `~/.ssh/authorized_keys` on the server they are letting you into, then connect with ssh from bash. " +
    "The private half is kept for the person who launched this run and never leaves strut: no tool, file or reply holds it.",
  input: z.object({}),
  output: z.object({
    publicKey: z.string().describe("The `authorized_keys` line: ssh-ed25519 <key> strut"),
    fingerprint: z.string().describe("SHA256:…, as `ssh-keygen -l` and a server's log print it"),
    created: z.boolean().describe("Whether this call made the key"),
  }),
  async run(_cfg, ctx: StepContext) {
    const services = ctx.services as { secrets?: SecretsCapability; secretBlanks?: SecretBlanks } | undefined;
    const secrets = services?.secrets;
    if (!secrets) throw new Error("ssh/keygen needs the secrets capability (ctx.services.secrets)");
    const kept = await secrets.get(SSH_KEY_SECRET);
    if (kept) return { ...sshPublicKey(kept), created: false };
    const blanks = services?.secretBlanks;
    if (!blanks) throw new Error("ssh/keygen needs strut's own secret store (ctx.services.secretBlanks); this server's secrets are its host's");
    const pem = newSshKey();
    try {
      await blanks.fill(SSH_KEY_SECRET, pem, ctx.principal);
    } catch (e) {
      // Another run made it first: theirs is the key.
      const now = (e as Error).message.startsWith("secret_set:") ? await secrets.get(SSH_KEY_SECRET) : undefined;
      if (now) return { ...sshPublicKey(now), created: false };
      throw e;
    }
    return { ...sshPublicKey(pem), created: true };
  },
});
