import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { loadSshKey, newSshKey, serveSshAgent, sshPublicKey } from "./ssh-agent.js";

// The SSH agent strut serves a job's shell (the agent step's `sshKeys`).
// Offline: a raw client speaks the protocol; where OpenSSH is on PATH, its
// own `ssh-add` and `ssh-keygen -Y sign` talk to it too. Every OpenSSH call
// is ASYNC — the agent answers on this process's event loop.

const run = promisify(execFile);
const onPath = async (bin: string) => run("sh", ["-c", `command -v ${bin}`]).then(() => true, () => false);

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const str = (b: Buffer | string) => {
  const body = Buffer.from(b);
  return Buffer.concat([u32(body.length), body]);
};

/** Send one message, read one answer. */
async function ask(socket: string, msg: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = connect(socket);
    let buf = Buffer.alloc(0);
    c.on("error", reject);
    c.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        c.end();
        resolve(buf.subarray(4, 4 + buf.readUInt32BE(0)));
      }
    });
    c.write(Buffer.concat([u32(msg.length), msg]));
  });
}

/** The key blobs an IDENTITIES_ANSWER lists. */
function blobsOf(answer: Buffer): Buffer[] {
  assert.equal(answer[0], 12);
  const n = answer.readUInt32BE(1);
  const out: Buffer[] = [];
  let at = 5;
  for (let i = 0; i < n; i++) {
    const len = answer.readUInt32BE(at);
    out.push(answer.subarray(at + 4, at + 4 + len));
    at += 4 + len;
    at += 4 + answer.readUInt32BE(at); // the comment
  }
  return out;
}

describe("ssh keys", () => {
  it("a new key is Ed25519 PKCS#8, and its public half is an authorized_keys line", () => {
    const pem = newSshKey();
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
    const { publicKey, fingerprint } = sshPublicKey(pem);
    assert.match(publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* strut$/);
    assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(sshPublicKey(pem).publicKey, publicKey, "the same key, the same line");
    assert.notEqual(sshPublicKey(newSshKey()).publicKey, publicKey);
  });

  it("loads Ed25519 only, and says what it wanted", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    assert.throws(() => loadSshKey(rsa), /^Error: ssh_key: an rsa key/);
    assert.throws(() => loadSshKey("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"), /^Error: ssh_key: not a key strut can load/);
  });
});

describe("serveSshAgent", () => {
  it("lists the keys and signs with one: a signature the public half verifies", async () => {
    const pem = newSshKey();
    const agent = await serveSshAgent(async () => [pem, "not a key"]);
    try {
      const [blob, ...rest] = blobsOf(await ask(agent.socket, Buffer.from([11])));
      assert.equal(rest.length, 0, "the value that is not a key is skipped");
      assert.equal(`ssh-ed25519 ${blob.toString("base64")} strut`, sshPublicKey(pem).publicKey);

      const data = Buffer.from("session id and userauth request");
      const reply = await ask(agent.socket, Buffer.concat([Buffer.from([13]), str(blob), str(data), u32(0)]));
      assert.equal(reply[0], 14);
      const sig = reply.subarray(5);
      assert.equal(sig.subarray(4, 15).toString(), "ssh-ed25519");
      const raw = sig.subarray(19, 19 + sig.readUInt32BE(15));
      assert.equal(raw.length, 64);
      assert.ok(verify(null, data, createPublicKey(loadSshKey(pem)), raw));
    } finally {
      await agent.close();
    }
  });

  it("reads the keys at every request, so a key stored mid-turn signs at once", async () => {
    const keys: string[] = [];
    const agent = await serveSshAgent(async () => keys);
    try {
      assert.equal(blobsOf(await ask(agent.socket, Buffer.from([11]))).length, 0);
      keys.push(newSshKey());
      assert.equal(blobsOf(await ask(agent.socket, Buffer.from([11]))).length, 1);
    } finally {
      await agent.close();
    }
  });

  it("refuses everything but list and sign: an unknown key, adding, removing, locking, extensions", async () => {
    const agent = await serveSshAgent(async () => [newSshKey()]);
    try {
      const stranger = Buffer.concat([str("ssh-ed25519"), str(Buffer.alloc(32, 7))]);
      assert.deepEqual(await ask(agent.socket, Buffer.concat([Buffer.from([13]), str(stranger), str("x"), u32(0)])), Buffer.from([5]));
      for (const type of [17, 18, 19, 22, 27]) assert.deepEqual(await ask(agent.socket, Buffer.from([type, 0, 0])), Buffer.from([5]), `type ${type}`);
      // A sign request cut short is a failure, not a crash.
      assert.deepEqual(await ask(agent.socket, Buffer.from([13, 0, 0, 0, 99])), Buffer.from([5]));
    } finally {
      await agent.close();
    }
  });

  it("close removes the socket and ends open connections", async () => {
    const agent = await serveSshAgent(async () => []);
    const held = connect(agent.socket);
    await new Promise((r) => held.once("connect", r));
    const ended = new Promise((r) => held.once("close", r));
    await agent.close();
    await ended;
    assert.equal(existsSync(agent.socket), false);
    await agent.close(); // twice is fine
  });

  it("OpenSSH's own tools use it: ssh-add lists the key, ssh-keygen signs through it", async (t) => {
    if (!(await onPath("ssh-add")) || !(await onPath("ssh-keygen"))) return t.skip("OpenSSH is not on PATH");
    const pem = newSshKey();
    const { publicKey, fingerprint } = sshPublicKey(pem);
    const agent = await serveSshAgent(async () => [pem]);
    const dir = mkdtempSync(join(tmpdir(), "strut-ssh-test-"));
    try {
      const env = { PATH: process.env["PATH"], SSH_AUTH_SOCK: agent.socket };
      assert.equal((await run("ssh-add", ["-L"], { env })).stdout.trim(), publicKey);
      assert.match((await run("ssh-add", ["-l"], { env })).stdout, new RegExp(fingerprint.replace(/[+/]/g, "\\$&")));
      writeFileSync(join(dir, "k.pub"), `${publicKey}\n`);
      writeFileSync(join(dir, "msg"), "hello");
      await run("ssh-keygen", ["-Y", "sign", "-f", join(dir, "k.pub"), "-n", "file", join(dir, "msg")], { env });
      writeFileSync(join(dir, "allowed"), `me ${publicKey}\n`);
      const { stdout } = await run("sh", ["-c", `ssh-keygen -Y verify -f allowed -I me -n file -s msg.sig < msg`], { cwd: dir, env });
      assert.match(stdout, /Good "file" signature for me/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await agent.close();
    }
  });
});
