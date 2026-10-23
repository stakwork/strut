import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putVault, getVault, destroyVault, HANDLE_RE, kindOf, type VaultDeps } from "./vault.js";
import { secretKeyProvider, VAULT_KEY_SECRET, VAULT_KEY_SECRET_LEGACY, type KeyProvider } from "./keys.js";

const map = { "[PERSON_1]": { type: "PERSON", value: "Ann" } };
const SECRET = "correct horse battery staple";
const ctxWith = (secrets: Record<string, string>) => ({ services: { secrets: { get: async (n: string) => secrets[n] } } });
const ctx = ctxWith({ [VAULT_KEY_SECRET]: SECRET });

describe("vault", () => {
  let dir: string;
  let d: VaultDeps;
  let clock: number;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-vault-"));
    clock = 1_000_000;
    d = { dir: join(dir, "privacy", "vault"), now: () => clock };
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("memory: round trip, no key needed, handle is pvm_<24 hex> only", async () => {
    const h = await putVault("memory", map, 5, {}, d);
    assert.match(h, /^pvm_[0-9a-f]{24}$/);
    assert.equal(kindOf(h), "memory");
    assert.deepEqual(await getVault(h, {}, d), map);
    assert.equal(await destroyVault(h, d), true);
    assert.equal(await getVault(h, {}, d), null);
    assert.equal(await destroyVault(h, d), false);
  });
  it("memory: expires, and expired entries are purged on put", async () => {
    const h = await putVault("memory", map, 1, {}, d);
    clock += 61_000;
    assert.equal(await getVault(h, {}, d), null);
    const h2 = await putVault("memory", map, 1, {}, d);
    assert.deepEqual(await getVault(h2, {}, d), map);
  });
  it("file: round trip under <dir>/<id>.enc, mode 0600 in a 0700 dir, plaintext not on disk", async () => {
    const h = await putVault("file", map, 5, ctx, d);
    assert.match(h, /^pvf_[0-9a-f]{24}$/);
    const files = await readdir(d.dir);
    assert.deepEqual(files, [h.slice(4) + ".enc"]);
    assert.equal((await stat(join(d.dir, files[0]!))).mode & 0o777, 0o600);
    assert.equal((await stat(d.dir)).mode & 0o777, 0o700);
    const raw = await readFile(join(d.dir, files[0]!), "utf-8");
    assert.ok(!raw.includes("Ann") && !raw.includes(SECRET));
    const rec = JSON.parse(raw);
    assert.deepEqual(Object.keys(rec).sort(), ["ct", "exp", "iv", "kid", "salt", "v"]);
    assert.equal(rec.v, 2);
    assert.ok(!h.includes(rec.kid) && !h.includes(SECRET));
    assert.deepEqual(await getVault(h, ctx, d), map);
    assert.equal(await destroyVault(h, d), true);
    assert.deepEqual(await readdir(d.dir), []);
  });
  it("file: expired reads as null and the file is removed", async () => {
    const h = await putVault("file", map, 1, ctx, d);
    clock += 61_000;
    assert.equal(await getVault(h, ctx, d), null);
    assert.deepEqual(await readdir(d.dir), []);
  });
  it("file: a later put sweeps expired files", async () => {
    await putVault("file", map, 1, ctx, d);
    clock += 61_000;
    await putVault("file", map, 60, ctx, d);
    assert.equal((await readdir(d.dir)).length, 1);
  });
  it("file without a key throws naming STRUT_ANONYMIZATION_VAULT_KEY (put and get)", async () => {
    await assert.rejects(putVault("file", map, 5, ctxWith({}), d), /STRUT_ANONYMIZATION_VAULT_KEY/);
    const h = await putVault("file", map, 5, ctx, d);
    await assert.rejects(getVault(h, ctxWith({}), d), /STRUT_ANONYMIZATION_VAULT_KEY/);
    await assert.rejects(putVault("file", map, 5, {}, d), /STRUT_ANONYMIZATION_VAULT_KEY/);
  });
  it("wrong key (different kid) is a clear error", async () => {
    const h = await putVault("file", map, 5, ctx, d);
    await assert.rejects(getVault(h, ctxWith({ [VAULT_KEY_SECRET]: "another secret" }), d), /another key/);
  });
  it("tampered ciphertext, exp, or a file moved to another id is rejected", async () => {
    const h = await putVault("file", map, 5, ctx, d);
    const p = join(d.dir, h.slice(4) + ".enc");
    const rec = JSON.parse(await readFile(p, "utf-8"));

    const ct = Buffer.from(rec.ct, "base64"); ct[0] = ct[0]! ^ 1;
    await writeFile(p, JSON.stringify({ ...rec, ct: ct.toString("base64") }));
    await assert.rejects(getVault(h, ctx, d), /could not be decrypted/);

    await writeFile(p, JSON.stringify({ ...rec, exp: rec.exp + 3_600_000 }));
    await assert.rejects(getVault(h, ctx, d), /could not be decrypted/);

    await writeFile(p, JSON.stringify(rec));
    const other = "pvf_" + "a".repeat(24);
    await writeFile(join(d.dir, "a".repeat(24) + ".enc"), JSON.stringify(rec));
    await assert.rejects(getVault(other, ctx, d), /could not be decrypted/);
    assert.deepEqual(await getVault(h, ctx, d), map);
  });
  it("handles never have a suffix and malformed ones are refused", async () => {
    for (const k of ["memory", "file"] as const) {
      const h = await putVault(k, map, 5, ctx, d);
      assert.match(h, HANDLE_RE);
      assert.equal(h.length, 28);
    }
    for (const bad of ["pvm_" + "a".repeat(24) + ".key", "pvm_zz", "x", "../etc/passwd", "pvf_" + "a".repeat(23)]) {
      await assert.rejects(getVault(bad, ctx, d), /invalid vault handle/);
      await assert.rejects(destroyVault(bad, d), /invalid vault handle/);
    }
  });
});

describe("keys", () => {
  it("reads STRUT_ANONYMIZATION_VAULT_KEY first, then the legacy STRUT_PRIVACY_KEY; no key -> null", async () => {
    const a = await secretKeyProvider.get(ctxWith({ [VAULT_KEY_SECRET]: "one", [VAULT_KEY_SECRET_LEGACY]: "two" }), { vault: "file" });
    assert.deepEqual(Buffer.from(a!.material).toString(), "one");
    const b = await secretKeyProvider.get(ctxWith({ [VAULT_KEY_SECRET_LEGACY]: "two" }), { vault: "file" });
    assert.deepEqual(Buffer.from(b!.material).toString(), "two");
    assert.match(b!.kid, /^[0-9a-f]{8}$/);
    assert.ok(!b!.kid.includes("two"));
    assert.equal(await secretKeyProvider.get(ctxWith({}), { vault: "file" }), null);
    assert.equal(await secretKeyProvider.get({}, { vault: "file" }), null);
  });
  it("a vault written under the legacy name opens with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-vault-"));
    try {
      const d: VaultDeps = { dir: join(dir, "v") };
      const legacy = ctxWith({ [VAULT_KEY_SECRET_LEGACY]: "old" });
      const h = await putVault("file", map, 5, legacy, d);
      assert.deepEqual(await getVault(h, legacy, d), map);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("an injected KeyProvider replaces the secret lookup and receives the purpose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-vault-"));
    try {
      const seen: unknown[] = [];
      const keys: KeyProvider = { async get(_c, p) { seen.push(p); return { kid: "custom01", material: new Uint8Array(32).fill(7) }; } };
      const d: VaultDeps = { dir: join(dir, "v"), keys };
      const h = await putVault("file", map, 5, {}, d);
      assert.deepEqual(await getVault(h, {}, d), map);
      assert.equal(JSON.parse(await readFile(join(d.dir, h.slice(4) + ".enc"), "utf-8")).kid, "custom01");
      assert.deepEqual(seen[0], { vault: "file" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
