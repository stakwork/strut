/** The job check subject (plans/job-claims.md §3): the index's view, as a check's input. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JobView } from "./job-index.js";
import { buildJobSubject } from "./job-subject.js";

const view: JobView = {
  job: "j-1",
  title: "Settings page",
  usedAt: "2026-10-14T10:00:00.000Z",
  holds: [
    { id: "pod-1", kind: "pod", since: "2026-10-14T09:00:00.000Z", release: { type: "pod/release", input: { id: "pod-1" } }, url: "https://pod-1.example", note: "frontend" },
    { id: "vm-1", kind: "vm", since: "2026-10-14T09:00:00.000Z", release: { type: "vm/release", input: {} } },
  ],
  urls: { pod: "https://pod-1.example" },
  repos: ["app"],
  files: ["plan.md", "shots/001.png"],
  runs: [{ workflow: "job", runId: "1700", at: "2026-10-14T09:59:00.000Z", status: "success" }],
  sessions: [],
  artifacts: [{ id: "plan", kind: "markdown", title: "Plan", url: "/jobs/j-1/files/plan.md", runId: "1700", path: "plan.md" }],
  text: "The settings page is up.",
};

describe("buildJobSubject", () => {
  it("is the view's state — directory, repos, deliverables, holds with their urls — about the turn given, with its output", () => {
    const subject = buildJobSubject(view, { runId: "1700", dir: "/data/jobs/j-1", output: { text: "The settings page is up.", artifacts: [] } });
    assert.deepEqual(subject, {
      job: "j-1",
      runId: "1700",
      dir: "/data/jobs/j-1",
      repos: ["app"],
      artifacts: view.artifacts,
      holds: view.holds,
      urls: { pod: "https://pod-1.example" },
      output: { text: "The settings page is up.", artifacts: [] },
      text: "The settings page is up.",
    });
    // What a check's config reaches: `{{ input.urls.pod }}/settings`, `{{ input.dir }}`.
    assert.equal(`${subject.urls["pod"]}/settings`, "https://pod-1.example/settings");
  });

  it("carries no output or text when there is none to carry", () => {
    const { text: _t, ...quiet } = view;
    const subject = buildJobSubject({ ...quiet, holds: [], urls: {}, artifacts: [] }, { runId: "1701", dir: "/data/jobs/j-1" });
    assert.equal("output" in subject, false);
    assert.equal("text" in subject, false);
    assert.deepEqual([subject.holds, subject.urls, subject.artifacts], [[], {}, []]);
  });
});
