/**
 * SSH keys a shell logs in with but never holds: the `agent` step's
 * `sshKeys`, and the key `ssh/keygen` makes.
 *
 * ssh reads a private key from a file or from an AGENT, never from the
 * environment. So a key handed to bash the way `secretsEnv` hands a token
 * would be written to disk every turn, where any job's shell, any reader
 * of the job's files and the model itself can read it, and a prompt-injected
 * shell could send it away. Here the key stays in strut's process: this is
 * an SSH agent (the protocol `ssh-agent` speaks, draft-miller-ssh-agent),
 * served on a unix socket for one run. Bash gets `SSH_AUTH_SOCK`, so `ssh`,
 * `scp`, `rsync` and `git` sign through it. The shell can USE a key while
 * the run lasts; it can never COPY one.
 *
 * Only what logging in needs: list the keys, sign with one. Adding,
 * removing, locking and extensions answer failure. Keys are Ed25519 in
 * PKCS#8 PEM, the form `node:crypto` reads and `newSshKey` writes; a value
 * that is not one is skipped. `keys()` is read at every request, so a key
 * stored mid-turn signs at once.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The secret the job's key is kept under: what `ssh/keygen` fills and the
 *  `job` workflow's agent names in `sshKeys`. */
export const SSH_KEY_SECRET = "SSH_KEY";

const ED25519 = "ssh-ed25519";

// Message numbers (draft-miller-ssh-agent §6.1).
const FAILURE = 5;
const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;

/** No request a client sends to list or sign is anywhere near this. */
const MAX_MESSAGE = 256 * 1024;

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** SSH's `string`: a uint32 length, then the bytes. */
function sshString(b: Buffer | string): Buffer {
  const body = typeof b === "string" ? Buffer.from(b) : b;
  return Buffer.concat([uint32(body.length), body]);
}

/** A key strut can sign with: an Ed25519 private key in PKCS#8 PEM. */
export function loadSshKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("ssh_key: not a key strut can load — an Ed25519 private key in PKCS#8 PEM, what ssh/keygen makes");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`ssh_key: an ${key.asymmetricKeyType} key — strut loads Ed25519 keys only`);
  }
  return key;
}

/** The public key as the wire sees it: string "ssh-ed25519", string the 32 bytes. */
function publicBlob(key: KeyObject): Buffer {
  const x = createPublicKey(key).export({ format: "jwk" }).x;
  return Buffer.concat([sshString(ED25519), sshString(Buffer.from(x!, "base64url"))]);
}

/** A private key's public half, as an `authorized_keys` line, and its
 *  fingerprint as `ssh-keygen -l` prints it. */
export function sshPublicKey(pem: string, comment = "strut"): { publicKey: string; fingerprint: string } {
  const blob = publicBlob(loadSshKey(pem));
  return {
    publicKey: `${ED25519} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

/** A new Ed25519 private key, PKCS#8 PEM. */
export function newSshKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string;
}

export interface SshAgent {
  /** The socket path: what `SSH_AUTH_SOCK` names. */
  socket: string;
  /** Stop answering, drop every connection, remove the socket. */
  close(): Promise<void>;
}

/** Serve the agent for the private keys `keys()` gives (PEM strings; one
 *  that does not load is skipped), on a socket in a fresh 0700 directory. */
export async function serveSshAgent(keys: () => Promise<string[]>): Promise<SshAgent> {
  const dir = await mkdtemp(join(tmpdir(), "strut-ssh-"));
  const socket = join(dir, "agent.sock");
  const open = new Set<Socket>();
  const server = createServer((conn) => {
    open.add(conn);
    conn.on("close", () => open.delete(conn));
    converse(conn, keys);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => resolve());
    });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  // A run that never closes it (no onRunEnd) must not keep the process up.
  server.unref();
  let closed: Promise<void> | undefined;
  return {
    socket,
    close() {
      closed ??= (async () => {
        for (const c of open) c.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      })();
      return closed;
    },
  };
}

/** One client: frames in, one answer per frame, in order. */
function converse(conn: Socket, keys: () => Promise<string[]>): void {
  let buf = Buffer.alloc(0);
  let queue: Promise<unknown> = Promise.resolve();
  conn.on("error", () => {});
  conn.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len === 0 || len > MAX_MESSAGE) {
        conn.destroy();
        return;
      }
      if (buf.length < 4 + len) return;
      const msg = Buffer.from(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
      queue = queue
        .then(() => answer(msg, keys))
        .catch(() => Buffer.from([FAILURE]))
        .then((reply) => {
          if (!conn.destroyed) conn.write(Buffer.concat([uint32(reply.length), reply]));
        });
    }
  });
}

async function answer(msg: Buffer, keys: () => Promise<string[]>): Promise<Buffer> {
  if (msg[0] === REQUEST_IDENTITIES) {
    const loaded = await loadAll(keys);
    return Buffer.concat([
      Buffer.from([IDENTITIES_ANSWER]),
      uint32(loaded.length),
      ...loaded.flatMap((k) => [sshString(k.blob), sshString("strut")]),
    ]);
  }
  if (msg[0] === SIGN_REQUEST) {
    let at = 1;
    const field = (): Buffer => {
      const len = msg.readUInt32BE(at);
      const out = msg.subarray(at + 4, at + 4 + len);
      if (out.length !== len) throw new Error("short");
      at += 4 + len;
      return out;
    };
    const blob = field();
    const data = field();
    const key = (await loadAll(keys)).find((k) => k.blob.equals(blob));
    if (!key) return Buffer.from([FAILURE]);
    const signature = Buffer.concat([sshString(ED25519), sshString(sign(null, data, key.key))]);
    return Buffer.concat([Buffer.from([SIGN_RESPONSE]), sshString(signature)]);
  }
  return Buffer.from([FAILURE]);
}

async function loadAll(keys: () => Promise<string[]>): Promise<{ key: KeyObject; blob: Buffer }[]> {
  const out: { key: KeyObject; blob: Buffer }[] = [];
  for (const pem of await keys()) {
    try {
      const key = loadSshKey(pem);
      out.push({ key, blob: publicBlob(key) });
    } catch {
      // Not a key strut can load: skipped, as if it were not there.
    }
  }
  return out;
}
