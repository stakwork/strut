import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { actorSecretStore } from "../../../actor-secrets.js";
import { secretsCapability } from "../../../capabilities.js";
import { MemorySecretStore, secretBlanks } from "../../../secret-store.js";
import { sshPublicKey } from "../../../ssh-agent.js";
import keygen from "./keygen.js";

// ssh/keygen: the private half is made and stored in code — the run
// principal's own SSH_KEY, else the server's — and only the public half
// comes back. One key per person, never replaced.

function server(env: Record<string, string | undefined> = {}) {
  const store = new MemorySecretStore();
  const actors = actorSecretStore(new MemorySecretStore());
  const secrets = secretsCapability(store, { envFallback: env, actors });
  const blanks = secretBlanks(store, () => env, actors);
  const ctxOf = (principal?: string) =>
    ({
      ...(principal ? { principal } : {}),
      services: { secrets: principal ? secrets.forPrincipal!(principal) : secrets, secretBlanks: blanks },
    }) as never;
  return { store, actors, ctxOf };
}

describe("ssh/keygen", () => {
  it("makes the person's key once, keeps it as their own secret, and returns only the public half", async () => {
    const { store, actors, ctxOf } = server();
    const made = await keygen.run({}, ctxOf("alice"));
    assert.equal(made.created, true);
    assert.match(made.publicKey, /^ssh-ed25519 \S+ strut$/);
    const pem = await actors.get("alice", "SSH_KEY");
    assert.ok(pem, "stored as alice's");
    assert.equal(sshPublicKey(pem).publicKey, made.publicKey);
    assert.ok(!JSON.stringify(made).includes("PRIVATE"), "no private half in the answer");
    assert.equal(await store.get("SSH_KEY"), undefined, "not the server's");

    const again = await keygen.run({}, ctxOf("alice"));
    assert.deepEqual(again, { ...made, created: false });

    const bob = await keygen.run({}, ctxOf("bob"));
    assert.equal(bob.created, true);
    assert.notEqual(bob.publicKey, made.publicKey, "each person their own");
  });

  it("with no principal, the server's blank; a key the server already has is everyone's answer", async () => {
    const { store, actors, ctxOf } = server();
    const made = await keygen.run({}, ctxOf());
    assert.equal(made.created, true);
    assert.equal(sshPublicKey((await store.get("SSH_KEY"))!).publicKey, made.publicKey);
    // A person's run resolves the server's key first: nothing new is made.
    assert.deepEqual(await keygen.run({}, ctxOf("carol")), { ...made, created: false });
    assert.equal(await actors.get("carol", "SSH_KEY"), undefined);
  });

  it("an SSH_KEY that is no key strut can load says so; no store of strut's says so", async () => {
    const { ctxOf } = server({ SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----" });
    await assert.rejects(() => keygen.run({}, ctxOf("alice")), /ssh_key: not a key strut can load/);
    await assert.rejects(() => keygen.run({}, { services: { secrets: { get: async () => undefined } } } as never), /strut's own secret store/);
  });

  it("two at once: the second finds the first's key", async () => {
    const { ctxOf } = server();
    const [a, b] = await Promise.all([keygen.run({}, ctxOf("alice")), keygen.run({}, ctxOf("alice"))]);
    assert.equal(a.publicKey, b.publicKey);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
  });
});
