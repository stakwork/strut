import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanName, createPeople, ownName, PEOPLE_IN_MEMORY, PEOPLE_READ_MAX, peoplePath, peopleReader } from "./people.js";
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
