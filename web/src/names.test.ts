import { test } from "node:test";
import assert from "node:assert/strict";
import { actorLabel, createNameCache } from "./names";

test("actorLabel: the name, else the text before the first dash", () => {
  assert.equal(actorLabel("evanfeenstra-s8fhs8", "Evan"), "Evan");
  assert.equal(actorLabel("evanfeenstra-s8fhs8", undefined), "evanfeenstra");
});

test("the name cache asks for each actor once, the actors of one tick together, 200 a read", async () => {
  const reads: string[][] = [];
  let tick: (() => void) | undefined;
  const cache = createNameCache(async (actors) => {
    reads.push(actors);
    return Object.fromEntries(actors.map((a) => [a, a === "ada-1" ? { name: "Ada" } : {}]));
  }, (fn) => (tick = fn));
  let heard = 0;
  cache.subscribe(() => heard++);
  cache.want(["ada-1", "bob-2", undefined]);
  cache.want(["ada-1", ...Array.from({ length: 200 }, (_, i) => `x-${i}`)]);
  assert.equal(reads.length, 0, "not before the tick");
  tick!();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reads.map((r) => r.length), [200, 2]);
  assert.equal(cache.nameOf("ada-1"), "Ada");
  assert.equal(cache.nameOf("bob-2"), undefined);
  assert.equal(heard, 1);
  tick = undefined;
  cache.want(["ada-1", "bob-2"]);
  assert.equal(tick, undefined, "asked once");
});

test("a refused read stops the asking: every actor shows as before", async () => {
  let reads = 0;
  const cache = createNameCache(async () => {
    reads++;
    return null;
  }, (fn) => fn());
  cache.want(["ada-1"]);
  await new Promise((r) => setTimeout(r, 0));
  cache.want(["bob-2"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(reads, 1);
  assert.equal(cache.nameOf("ada-1"), undefined);
});
