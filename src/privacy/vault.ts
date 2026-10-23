import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { secretKeyProvider, VAULT_KEY_SECRET, type KeyCtx, type KeyProvider } from "./keys.js";
import type { TokenMap, VaultKind } from "./types.js";

export const HANDLE_RE = /^pv([mf])_[0-9a-f]{24}$/;
const INFO = "strut-privacy-vault";
const SWEEP_CAP = 100;

export interface VaultDeps {
  /** `<dataDir>/privacy/vault` — where file vaults live. */
  dir: string;
  keys?: KeyProvider;
  now?: () => number;
}

type MemEntry = { map: TokenMap; exp: number };
const G = globalThis as unknown as { __strutPrivacyVault?: Map<string, MemEntry> };
const mem = (): Map<string, MemEntry> => (G.__strutPrivacyVault ??= new Map());

function purgeMemory(now: number) {
  for (const [id, v] of mem()) if (v.exp <= now) mem().delete(id);
}

export function kindOf(handle: string): VaultKind {
  const m = HANDLE_RE.exec(handle);
  if (!m) throw new Error("invalid vault handle");
  return m[1] === "m" ? "memory" : "file";
}

const idOf = (handle: string) => handle.slice(4);
const filePath = (d: VaultDeps, handle: string) => join(d.dir, idOf(handle) + ".enc");

function deriveKey(material: Uint8Array, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", material, salt, INFO, 32));
}

type FileRecord = { v: 2; kid: string; exp: number; salt: string; iv: string; ct: string };
const aad = (id: string, exp: number) => Buffer.from(id + ":" + exp);

async function sweepFiles(d: VaultDeps, now: number) {
  let names: string[];
  try { names = await readdir(d.dir); } catch { return; }
  for (const n of names.slice(0, SWEEP_CAP)) {
    if (!n.endsWith(".enc")) continue;
    try {
      const rec = JSON.parse(await readFile(join(d.dir, n), "utf-8")) as FileRecord;
      if (typeof rec.exp === "number" && rec.exp <= now) await rm(join(d.dir, n), { force: true });
    } catch { /* unreadable: leave it */ }
  }
}

/** Store a token map; returns the handle (`pvm_…` memory, `pvf_…` file). A file vault needs the key. */
export async function putVault(kind: VaultKind, map: TokenMap, ttlMinutes: number, ctx: KeyCtx, d: VaultDeps): Promise<string> {
  const now = (d.now ?? Date.now)();
  const exp = now + ttlMinutes * 60_000;
  const id = randomBytes(12).toString("hex");
  if (kind === "memory") {
    purgeMemory(now);
    mem().set(id, { map, exp });
    return "pvm_" + id;
  }
  const key = await (d.keys ?? secretKeyProvider).get(ctx, { vault: "file" });
  if (!key) throw new Error(`vault "file" needs the secret ${VAULT_KEY_SECRET} (set it under Secrets or in the environment)`);
  await sweepFiles(d, now);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(key.material, salt), iv);
  c.setAAD(aad(id, exp));
  const ct = Buffer.concat([c.update(JSON.stringify({ map }), "utf-8"), c.final(), c.getAuthTag()]);
  const rec: FileRecord = { v: 2, kid: key.kid, exp, salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
  await mkdir(d.dir, { recursive: true, mode: 0o700 });
  await writeFile(join(d.dir, id + ".enc"), JSON.stringify(rec), { mode: 0o600, flag: "wx" });
  return "pvf_" + id;
}

/** The map for a handle, or null when it is unknown or expired. A wrong key or a tampered file throws. */
export async function getVault(handle: string, ctx: KeyCtx, d: VaultDeps): Promise<TokenMap | null> {
  const kind = kindOf(handle);
  const now = (d.now ?? Date.now)();
  if (kind === "memory") {
    purgeMemory(now);
    return mem().get(idOf(handle))?.map ?? null;
  }
  let rec: FileRecord;
  try {
    rec = JSON.parse(await readFile(filePath(d, handle), "utf-8")) as FileRecord;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw new Error("vault file could not be read");
  }
  const key = await (d.keys ?? secretKeyProvider).get(ctx, { vault: "file" });
  if (!key) throw new Error(`vault "file" needs the secret ${VAULT_KEY_SECRET} (set it under Secrets or in the environment)`);
  if (rec.v !== 2 || typeof rec.exp !== "number") throw new Error("vault file has an unknown format");
  if (rec.kid !== key.kid) throw new Error(`vault was written with another key (kid ${rec.kid}, current ${key.kid})`);
  let plain: string;
  try {
    const ct = Buffer.from(rec.ct, "base64");
    const dec = createDecipheriv("aes-256-gcm", deriveKey(key.material, Buffer.from(rec.salt, "base64")), Buffer.from(rec.iv, "base64"));
    dec.setAAD(aad(idOf(handle), rec.exp));
    dec.setAuthTag(ct.subarray(ct.length - 16));
    plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]).toString("utf-8");
  } catch {
    throw new Error("vault could not be decrypted: wrong key or the file was altered");
  }
  if (rec.exp <= now) {
    await rm(filePath(d, handle), { force: true });
    return null;
  }
  return (JSON.parse(plain) as { map: TokenMap }).map;
}

/** Remove a vault. True when something was there. */
export async function destroyVault(handle: string, d: VaultDeps): Promise<boolean> {
  if (kindOf(handle) === "memory") return mem().delete(idOf(handle));
  const p = filePath(d, handle);
  try {
    await readFile(p);
  } catch {
    return false;
  }
  await rm(p, { force: true });
  return true;
}
