/**
 * The address space a Ladybug graph reserves (max-size.ts): the setting, and
 * that it is not kept in the file — a graph made under 1 TiB (a Mac) opens
 * under a smaller size (a Raspberry Pi's 39-bit address space).
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_DB_SIZE, ladybugMaxDbSize } from "./max-size.js";
import { openLadybug } from "./db.js";
import { testBackends } from "../test-util.js";

const skip = testBackends().find((b) => b.kind === "ladybug")!.skip;

describe("STRUT_LADYBUG_MAX_DB_SIZE", () => {
  it("defaults to 64 GiB, takes bytes or a binary unit, and refuses what Ladybug would", () => {
    assert.equal(DEFAULT_MAX_DB_SIZE, 2 ** 36);
    assert.equal(ladybugMaxDbSize({}), 2 ** 36);
    assert.equal(ladybugMaxDbSize({ STRUT_LADYBUG_MAX_DB_SIZE: " " }), 2 ** 36);
    assert.equal(ladybugMaxDbSize({ STRUT_LADYBUG_MAX_DB_SIZE: String(2 ** 34) }), 2 ** 34);
    assert.equal(ladybugMaxDbSize({ STRUT_LADYBUG_MAX_DB_SIZE: "16G" }), 2 ** 34);
    assert.equal(ladybugMaxDbSize({ STRUT_LADYBUG_MAX_DB_SIZE: "512MiB" }), 2 ** 29);
    assert.equal(ladybugMaxDbSize({ STRUT_LADYBUG_MAX_DB_SIZE: "1tb" }), 2 ** 40);
    for (const bad of ["3G", "4M", "lots", "-64G", "1.5G"]) {
      assert.throws(() => ladybugMaxDbSize({ STRUT_LADYBUG_MAX_DB_SIZE: bad }), /STRUT_LADYBUG_MAX_DB_SIZE=.*power of two/, bad);
    }
  });
});

describe("a graph's max size is not kept in its file", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-lbug-max-"));
  const saved = process.env["STRUT_LADYBUG_MAX_DB_SIZE"];
  after(() => {
    if (saved === undefined) delete process.env["STRUT_LADYBUG_MAX_DB_SIZE"];
    else process.env["STRUT_LADYBUG_MAX_DB_SIZE"] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("made under 1 TiB, it reopens under 64 MiB with its data, and a bad setting fails the open by name", async () => {
    const file = join(dir, "g", "graph.lbug");
    process.env["STRUT_LADYBUG_MAX_DB_SIZE"] = "1T";
    const made = await openLadybug(file);
    await made.withWrite((tx) => tx.run("CREATE (:Node {ref_id: 'a', name: 'one', Data_Bank: 'made on the mac'})"));
    await made.close();

    process.env["STRUT_LADYBUG_MAX_DB_SIZE"] = "64M";
    const small = await openLadybug(file);
    try {
      assert.equal((await small.query("MATCH (n:Node {ref_id: 'a'}) RETURN n.Data_Bank AS t"))[0]!["t"], "made on the mac");
      await small.withWrite((tx) => tx.run("CREATE (:Node {ref_id: 'b', name: 'two', Data_Bank: 'written on the pi'})"));
    } finally {
      await small.close();
    }

    process.env["STRUT_LADYBUG_MAX_DB_SIZE"] = "3G";
    await assert.rejects(openLadybug(file), /STRUT_LADYBUG_MAX_DB_SIZE=3G/);
  });
});
