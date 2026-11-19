import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLinkChallenge } from "./auth.js";
import { accountAddress, accountsCapability, accountText, cleanName, createPeople, ownName, parseAccount, PEEL_LINK, PEOPLE_IN_MEMORY, PEOPLE_READ_MAX, peoplePath, peopleReader } from "./people.js";
import { RUN_STEP_FLOW } from "./run-step.js";
import { setEnv } from "./test-util/public-door.js";
import linkStep from "./steps/lib/account/link.js";
import links from "./steps/lib/account/links.js";
import unlink from "./steps/lib/account/unlink.js";
import names from "./steps/lib/people/names.js";

describe("people (plans/people-and-hosts.md §1)", () => {
  it("a name is one line, trimmed, at most 80 characters", () => {
    assert.equal(cleanName("  Ada \n\t Lovelace \r\n"), "Ada Lovelace");
    assert.equal(cleanName("a\u0000b"), "a b");
    assert.equal(cleanName("x".repeat(81)), "x".repeat(80));
    assert.equal(cleanName("😀".repeat(81)), "😀".repeat(80), "80 characters, never half of one");
    assert.equal(cleanName(`${"y".repeat(79)} z`), "y".repeat(79), "trimmed after the cut");
    assert.equal(cleanName("   "), undefined);
    assert.equal(cleanName(42), undefined);
  });

  it("a host's name is never replaced by a person's own; within each kind the newest wins", async () => {
    const people = createPeople(PEOPLE_IN_MEMORY);
    assert.equal(await people.setName("a-1", "Ada", "self"), true);
    assert.equal(await people.setName("a-1", "Ada Lovelace", "self"), true);
    assert.equal(await people.nameOf("a-1"), "Ada Lovelace");
    assert.equal(await people.setName("a-1", "Ada L.", "host"), true, "a host's replaces a person's own");
    assert.equal(await people.setName("a-1", "Countess", "self"), false);
    assert.equal(await people.nameOf("a-1"), "Ada L.");
    assert.equal(await people.setName("a-1", "Ada King", "host"), true);
    assert.equal(await people.nameOf("a-1"), "Ada King");
    assert.equal(await people.setName("a-1", " ", "host"), false, "nothing to keep");
    assert.equal(await people.nameOf("a-1"), "Ada King");
    assert.equal(await people.nameOf("b-2"), undefined);
    await people.close();
  });

  it("a read answers every actor asked, at most 200, and opens no file that is not there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-people-"));
    try {
      const file = peoplePath(join(dir, "data"));
      const people = createPeople(file);
      assert.deepEqual(await people.names(["a-1", "b-2", "a-1"]), { "a-1": {}, "b-2": {} });
      assert.equal(existsSync(file), false, "no name, no file");
      await people.setName("a-1", "Ada", "host");
      assert.equal(statSync(file).mode & 0o777, 0o600, "owner-only");
      assert.deepEqual(await people.names(["a-1", "b-2"]), { "a-1": { name: "Ada" }, "b-2": {} });
      await assert.rejects(people.names(Array.from({ length: PEOPLE_READ_MAX + 1 }, (_, i) => `x-${i}`)), /at most 200/);
      await people.close();
      // Kept across a reopen.
      const again = createPeople(file);
      assert.equal(await again.nameOf("a-1"), "Ada");
      await again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("people/names reads the bag's reader: every name, a visitor's own alone, or none", async () => {
    const people = createPeople(PEOPLE_IN_MEMORY);
    await people.setName("a-1", "Ada", "host");
    await people.setName("b-2", "Bob", "self");
    const run = (bag: Record<string, unknown>) => names.run({ actors: ["a-1", "b-2"] }, { services: bag } as never);
    assert.deepEqual(await run({ people: peopleReader(people) }), { people: { "a-1": { name: "Ada" }, "b-2": { name: "Bob" } } });
    assert.deepEqual(await run({ people: ownName(people, "b-2") }), { people: { "a-1": {}, "b-2": { name: "Bob" } } });
    assert.deepEqual(await run({}), { people: { "a-1": {}, "b-2": {} } });
    assert.equal("setName" in peopleReader(people), false, "a step never writes");
    await people.close();
  });
});

describe("accounts (plans/people-and-hosts.md §2)", () => {
  const KEY = `02${"ab".repeat(32)}`;
  const LSP = `03${"cd".repeat(32)}`;

  it("one spelling of an account: <kind>:<key>, a Sphinx key its 66 hex in lowercase", () => {
    assert.deepEqual(parseAccount(`sphinx:${KEY.toUpperCase()}`), { kind: "sphinx", key: KEY });
    assert.equal(accountText(parseAccount(`sphinx:${KEY}`)!), `sphinx:${KEY}`);
    for (const bad of [`sphinx:04${"ab".repeat(32)}`, `sphinx:${KEY}00`, `sphinx:${"ab".repeat(32)}`, KEY, `:${KEY}`, `Sphinx:${KEY}`, 42]) {
      assert.equal(parseAccount(bad), undefined, String(bad));
    }
    assert.deepEqual(parseAccount("email:ada@example.com"), { kind: "email", key: "ada@example.com" }, "any other kind: a key with no space");
    assert.equal(parseAccount("email:ada lovelace"), undefined);
    // An address names the account's own key.
    const account = { kind: "sphinx", key: KEY };
    assert.equal(accountAddress(account, `${KEY}_${LSP}_123`.toUpperCase()), `${KEY}_${LSP}_123`);
    assert.equal(accountAddress(account, `${LSP}_${LSP}_123`), undefined, "another key's address");
  });

  it("actorOf: the linked person; else a Sphinx key's own actor, unlinked; else nobody", async () => {
    const people = createPeople(PEOPLE_IN_MEMORY);
    const sphinx = { kind: "sphinx", key: KEY };
    assert.deepEqual(await people.actorOf(sphinx), { actor: `secp:${KEY.slice(2)}`, linked: false }, "the actor a signed sign-in with the key gives");
    assert.equal(await people.actorOf({ kind: "email", key: "ada@example.com" }), undefined);
    const link = await people.link(sphinx, "ada-1", { host: "sphinx", name: " Ada \n", address: `${KEY}_${LSP}_7` });
    assert.deepEqual(link, { account: `sphinx:${KEY}`, kind: "sphinx", key: KEY, actor: "ada-1", address: `${KEY}_${LSP}_7`, name: "Ada", host: "sphinx", at: link.at });
    assert.deepEqual(await people.actorOf(sphinx), { actor: "ada-1", linked: true });
    // One person per account: whoever holds the key says whose it is.
    await people.link(sphinx, "bob-2", { host: "sphinx" });
    assert.deepEqual(await people.actorOf(sphinx), { actor: "bob-2", linked: true });
    assert.deepEqual(await people.accountsOf("ada-1"), []);
    assert.equal(await people.unlink(sphinx, "ada-1"), false, "not Ada's any more");
    assert.equal(await people.unlink(sphinx, "bob-2"), true);
    assert.equal(await people.linkOf(sphinx), undefined);
    await people.close();
  });

  it("nameOf falls back to the name on an account that is the person's; their own name comes first", async () => {
    const people = createPeople(PEOPLE_IN_MEMORY);
    await people.link({ kind: "sphinx", key: KEY }, "ada-1", { name: "ada on sphinx" });
    assert.equal(await people.nameOf("ada-1"), "ada on sphinx");
    await people.setName("ada-1", "Ada Lovelace", "self");
    assert.equal(await people.nameOf("ada-1"), "Ada Lovelace");
    assert.deepEqual(await people.names(["ada-1", "bob-2"]), { "ada-1": { name: "Ada Lovelace" }, "bob-2": {} });
    await people.close();
  });

  it("setAccountName (x-strut-account-name, §1): on the account when linked, else the key's own actor's, as self", async () => {
    const people = createPeople(PEOPLE_IN_MEMORY);
    const sphinx = { kind: "sphinx", key: KEY };
    const own = `secp:${KEY.slice(2)}`;
    // Nobody linked it: the key's own actor, as a person names themself.
    assert.equal(await people.setAccountName(sphinx, " Zoë \n🌱 "), true);
    assert.equal(await people.nameOf(own), "Zoë 🌱");
    assert.equal(await people.setAccountName(sphinx, "Zoë 🌱"), false, "the same name changes nothing");
    await people.setName(own, "Zoe (staff)", "host");
    assert.equal(await people.setAccountName(sphinx, "Z"), false, "never over a host's");
    assert.equal(await people.nameOf(own), "Zoe (staff)");
    // Linked: on the account, beneath the person's own name.
    await people.link(sphinx, "ada-1", { name: "ada" });
    assert.equal(await people.setAccountName(sphinx, "Ada L."), true);
    assert.equal((await people.linkOf(sphinx))?.name, "Ada L.");
    assert.equal(await people.nameOf("ada-1"), "Ada L.");
    await people.setName("ada-1", "Ada Lovelace", "self");
    await people.setAccountName(sphinx, "Ada on Sphinx");
    assert.equal(await people.nameOf("ada-1"), "Ada Lovelace", "their own name comes first");
    assert.equal(await people.nameOf(own), "Zoe (staff)", "the key's own actor keeps its name");
    // Another kind nobody linked has no one to name; an empty name is none.
    assert.equal(await people.setAccountName({ kind: "email", key: "bob@example.com" }, "Bob"), false);
    assert.equal(await people.setAccountName(sphinx, " \n "), false);
    await people.close();
  });

  it("the account/* steps run only as strut's own app's call, for its viewer; account/link names them for Peel", async () => {
    const restore = setEnv({ STRUT_API_KEY: undefined, STRUT_SECRET_KEY: "people-test-secret" });
    const people = createPeople(PEOPLE_IN_MEMORY);
    const accounts = accountsCapability(people, { base: "https://box.example/lab", host: "box.example" });
    const page = { services: { accounts }, app: { name: "strut/jamie", version: "v1", firstParty: true as const }, actor: "ada-1", workflow: RUN_STEP_FLOW };
    await people.setName("ada-1", "Ada", "host");
    const made = (await linkStep.run({}, page as never)) as { challenge: string; exp: number; link: string; qr: string };
    // A challenge naming the viewer and the box, ten minutes, as Peel's link and its QR.
    assert.deepEqual(readLinkChallenge(made.challenge), { host: "box.example", actor: "ada-1", name: "Ada", nonce: readLinkChallenge(made.challenge)!.nonce, exp: made.exp });
    const link = new URL(made.link);
    assert.equal(`${link.protocol}//${link.host}${link.pathname}`, PEEL_LINK);
    assert.deepEqual([link.searchParams.get("url"), link.searchParams.get("challenge")], ["https://box.example/lab", made.challenge]);
    assert.match(made.qr, /^data:image\/svg\+xml;base64,/);
    // A bag with no address (a run strut started itself) makes none.
    await assert.rejects(linkStep.run({}, { ...page, services: { accounts: accountsCapability(people) } } as never), /names this strut server's address/);
    await people.link({ kind: "sphinx", key: KEY }, "ada-1");
    const listed = (await links.run({}, page as never)) as { links: Array<Record<string, unknown>> };
    assert.deepEqual(listed.links.map((l) => l["account"]), [`sphinx:${KEY}`]);
    assert.equal("actor" in listed.links[0]!, false);
    assert.deepEqual(await unlink.run({ account: `sphinx:${KEY}` }, page as never), { removed: true });
    // Never another app's page, an agent's tool (a run's step) or no viewer.
    for (const ctx of [
      { ...page, app: { name: "acme/app", version: "v1" } },
      { ...page, workflow: "orchestrator" },
      { ...page, actor: undefined },
      { services: { accounts }, actor: "ada-1", workflow: RUN_STEP_FLOW },
    ]) {
      await assert.rejects(linkStep.run({}, ctx as never), /strut's own app's call/);
      await assert.rejects(links.run({}, ctx as never), /strut's own app's call/);
    }
    await people.close();
    restore();
  });
});
