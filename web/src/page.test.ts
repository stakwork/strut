import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { memberApps, pickPage, soloAppHref } from "./page";

describe("pickPage", () => {
  const admin = { role: "admin" as const };
  const member = { role: "member" as const };

  it("the store front for whoever asks", () => {
    for (const s of [null, {}, admin, member]) assert.deepEqual(pickPage("?store=1", s), { kind: "store" });
  });

  it("?solo=1 shows an app or a file alone, for anyone", () => {
    for (const s of [null, {}, admin, member]) {
      assert.deepEqual(pickPage("?app=strut%2Fjamie&solo=1&input=session%3Dada-1%2Fs1&theme=light", s), {
        kind: "app",
        app: "strut/jamie",
        input: "session=ada-1/s1",
        visitor: false,
        theme: "light",
      });
      assert.deepEqual(pickPage("?artifact=%2Fjobs%2Fj1%2Ffiles%2Fplan.md&solo=1", s), { kind: "artifact", artifact: "/jobs/j1/files/plan.md" });
    }
    assert.deepEqual(pickPage("?app=acme%2Fsite&solo=1&public=1", null), { kind: "app", app: "acme/site", input: null, visitor: true });
  });

  it("the shell for the key, the key login, an admin, and a page with no session", () => {
    for (const s of [null, {}, admin]) {
      assert.deepEqual(pickPage("", s), { kind: "shell" });
      assert.deepEqual(pickPage("?wf=job&run=17", s), { kind: "shell" });
      assert.deepEqual(pickPage("?solo=1", s), { kind: "shell" });
      // Without solo, `?app=` selects the app in the shell.
      assert.deepEqual(pickPage("?app=strut%2Fjamie", s), { kind: "shell" });
    }
  });

  it("a member never gets the shell: their apps, or the app or file a link names, alone", () => {
    for (const q of ["", "?wf=job&run=17", "?secrets=1", "?solo=1", "?job=j1", "?chat=c1"]) assert.deepEqual(pickPage(q, member), { kind: "member-apps" }, q);
    assert.deepEqual(pickPage("?app=strut%2Fjamie&input=session%3Dada-1%2Fs1", member), { kind: "app", app: "strut/jamie", input: "session=ada-1/s1", visitor: false });
    assert.deepEqual(pickPage("?artifact=%2Fartifacts%2F17%2Fout.png", member), { kind: "artifact", artifact: "/artifacts/17/out.png" });
    assert.deepEqual(pickPage(new URLSearchParams({ app: "" }), member), { kind: "member-apps" });
  });
});

describe("memberApps", () => {
  it("the assistant first, then the pinned, then by title; no libraries", () => {
    const apps = [
      { name: "acme/zeta", title: "Zeta" },
      { name: "strut/views", title: "Strut views" },
      { name: "acme/alpha", title: "Alpha" },
      { name: "acme/pinned", title: "Pinned", pinned: true },
      { name: "strut/jamie", title: "Jamie" },
    ];
    assert.deepEqual(memberApps(apps).map((a) => a.name), ["strut/jamie", "acme/pinned", "acme/alpha", "acme/zeta"]);
  });

  it("links an app alone", () => {
    assert.equal(soloAppHref("strut/jamie"), "?app=strut%2Fjamie&solo=1");
  });
});
