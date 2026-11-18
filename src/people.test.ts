import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountAddress, accountsCapability, accountText, cleanName, createPeople, LINK_CODE_MS, ownName, parseAccount, PEOPLE_IN_MEMORY, PEOPLE_READ_MAX, peoplePath, peopleReader } from "./people.js";
import { RUN_STEP_FLOW } from "./run-step.js";
import linkCode from "./steps/lib/account/link-code.js";
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

  it("a link code: one per person, once, ten minutes, as typed", () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    try {
      const people = createPeople(PEOPLE_IN_MEMORY);
      const first = people.linkCode("ada-1");
      assert.match(first.code, /^link-[2-9a-hjkmnp-z]{8}$/);
      assert.equal(first.expiresAt, 1_000_000 + LINK_CODE_MS);
      const second = people.linkCode("ada-1");
      assert.equal(people.redeemLinkCode(first.code), undefined, "a new code replaces the last");
      assert.equal(people.redeemLinkCode(` ${second.code.slice(5).toUpperCase()} `), "ada-1", "case and link- optional");
      assert.equal(people.redeemLinkCode(second.code), undefined, "once");
      const late = people.linkCode("bob-2");
      mock.timers.tick(LINK_CODE_MS);
      assert.equal(people.redeemLinkCode(late.code), undefined, "expired");
      assert.equal(people.redeemLinkCode(42), undefined);
    } finally {
      mock.timers.reset();
    }
  });

  it("the account/* steps run only as strut's own app's call, for its viewer", async () => {
    const people = createPeople(PEOPLE_IN_MEMORY);
    const accounts = accountsCapability(people, { hosts: () => ["sphinx"], sphinx: async () => ({ address: `${KEY}_${LSP}_7`, alias: "Support" }) });
    const page = { services: { accounts }, app: { name: "strut/jamie", version: "v1", firstParty: true as const }, actor: "ada-1", workflow: RUN_STEP_FLOW };
    const made = (await linkCode.run({}, page as never)) as { code: string; hosts: string[]; to?: { address: string; alias?: string; qr: string } };
    assert.deepEqual(made.hosts, ["sphinx"]);
    assert.equal(made.to?.address, `${KEY}_${LSP}_7`);
    assert.equal(made.to?.alias, "Support");
    assert.match(made.to!.qr, /^data:image\/svg\+xml;base64,/);
    assert.equal(people.redeemLinkCode(made.code), "ada-1");
    await people.link({ kind: "sphinx", key: KEY }, "ada-1", { host: "sphinx" });
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
      await assert.rejects(linkCode.run({}, ctx as never), /strut's own app's call/);
      await assert.rejects(links.run({}, ctx as never), /strut's own app's call/);
    }
    // No Sphinx host here: a code, and nobody named to send it to.
    const none = accountsCapability(people, { hosts: () => [], sphinx: async () => assert.fail("not asked") });
    const bare = (await linkCode.run({}, { ...page, services: { accounts: none } } as never)) as { hosts: string[]; to?: unknown };
    assert.deepEqual(bare.hosts, []);
    assert.equal(bare.to, undefined);
    await people.close();
  });
});
