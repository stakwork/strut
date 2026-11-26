/**
 * The worker page's header (strut/views' WorkerPage, the Tasks app): whose
 * work it is. The server's name (its brand's, `useHost().name`) heads a page
 * that names itself nothing, with "Tasks" under it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workerHeading } from "./views/src/lib/heading.js";

const words = { title: "Tasks" };

describe("the worker page's heading", () => {
  it("the server's name, Tasks under it; without one, Tasks alone", () => {
    assert.deepEqual(workerHeading({ server: "Acme", words }), { title: "Acme", subtitle: "Tasks" });
    assert.deepEqual(workerHeading({ words }), { title: "Tasks", subtitle: "" });
    assert.deepEqual(workerHeading({ server: "  ", words }), { title: "Tasks", subtitle: "" }, "blank is none");
  });

  it("a page's own title and line win", () => {
    assert.deepEqual(workerHeading({ named: "Labels", server: "Acme", words }), { title: "Labels", subtitle: "" });
    assert.deepEqual(workerHeading({ server: "Acme", line: "", words }), { title: "Acme", subtitle: "" });
    assert.deepEqual(workerHeading({ named: "Labels", line: "Snap them", words }), { title: "Labels", subtitle: "Snap them" });
  });
});
