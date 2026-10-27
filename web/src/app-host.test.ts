import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appKey, appMessage, appToolInput, namesApp, parseAppKey, peerAppLink, strutLink } from "./app-links";
import { appLink } from "../../kit/src/links";

/** The pure parts of the app host's relay (./app-links, what ./app-host
 *  decides without the bridge): where a link leads, what a page's message
 *  becomes. The bridge itself is ext-apps'. */
describe("the app host", () => {
  const here = { origin: "https://strut.test", pathname: "/" };
  const lab = { origin: "https://swarm.test", pathname: "/lab/" };

  it("a strut deep link navigates in place; anything else opens a tab", () => {
    assert.deepEqual(strutLink("https://strut.test/?wf=bench&run=12", here), { wf: "bench", run: "12" });
    assert.deepEqual(strutLink("/?job=j1", here), { job: "j1" });
    assert.deepEqual(strutLink("?app=bench", here), { app: "bench" });
    assert.equal(strutLink("https://strut.test/?secrets=1", here), null, "no deep-link param");
    assert.equal(strutLink("https://elsewhere.test/?wf=bench", here), null, "another origin");
    assert.equal(strutLink("https://strut.test/artifacts/1/x.png", here), null, "a file, not the page");
    assert.equal(strutLink("not a url", { origin: "null", pathname: "" }), null);
    // Under a host's mount.
    assert.deepEqual(strutLink("https://swarm.test/lab/?wf=bench", lab), { wf: "bench" });
    assert.deepEqual(strutLink("https://swarm.test/lab?run=1&wf=w", lab), { run: "1", wf: "w" });
    assert.equal(strutLink("https://swarm.test/?wf=bench", lab), null, "the root is another page");
  });

  it("a link to an app carries what it is opened with, which becomes its tool-input", () => {
    const link = appLink("bench", { view: "/runs", run: 12 });
    const params = strutLink(link, here);
    assert.deepEqual(params, { app: "bench", input: "view=%2Fruns&run=12" });
    assert.deepEqual(appToolInput(params!["input"]), { view: "/runs", run: "12" }, "the kit's link, read back by the host");
    assert.deepEqual(strutLink("https://swarm.test/lab/?app=bench&input=view%3D%252Fruns", lab), { app: "bench", input: "view=%2Fruns" });
    assert.equal(appToolInput(null), undefined);
    assert.equal(appToolInput(""), undefined);
    assert.equal(appToolInput("&"), undefined, "no keys, no input");
  });

  it("a peer's page names apps on that peer; its other links are the peer's", () => {
    assert.deepEqual(peerAppLink({ app: "bench", input: "view=%2Fruns" }, "acme"), { app: "@acme/bench", input: "view=%2Fruns" });
    assert.deepEqual(peerAppLink({ app: "hive/ui" }, "acme"), { app: "@acme/hive/ui" });
    assert.equal(peerAppLink({ wf: "clip", run: "1" }, "acme"), null);
    assert.equal(peerAppLink({ app: "@other/bench" }, "acme"), null, "the peer's own peer");
  });

  it("a link to the app on screen is told apart from one to another app", () => {
    const bench = { name: "bench", version: "v3" };
    assert.equal(namesApp("bench", bench), true);
    assert.equal(namesApp("bench@v3", bench), true);
    assert.equal(namesApp("bench@v2", bench), false, "another version");
    assert.equal(namesApp("other", bench), false);
    assert.equal(namesApp(undefined, bench), false);
    assert.equal(namesApp("@acme/bench", { ...bench, peer: "acme" }), true);
    assert.equal(namesApp("bench", { ...bench, peer: "acme" }), false, "the peer's, not this strut's");
  });

  it("an app is named by its name here, and by its peer and name when it lives on a peer", () => {
    assert.equal(appKey({ name: "bench" }), "bench");
    assert.equal(appKey({ name: "hive/ui", peer: "acme" }), "@acme/hive/ui");
    for (const app of [{ name: "bench" }, { name: "strut/views" }, { name: "hive/ui", peer: "acme" }]) {
      assert.deepEqual(parseAppKey(appKey(app)), app, "read back");
    }
    for (const key of ["", "@acme", "@acme/", "@/x"]) assert.equal(parseAppKey(key), null, key);
  });

  it("a key may pin a version, as an import does", () => {
    assert.deepEqual(parseAppKey("bench@v3"), { name: "bench", version: "v3" });
    assert.deepEqual(parseAppKey("hive/ui@v12"), { name: "hive/ui", version: "v12" });
    assert.deepEqual(parseAppKey("@acme/hive/ui@v2"), { name: "hive/ui", peer: "acme", version: "v2" });
    for (const key of ["bench@", "bench@latest", "@v3", "@acme/@v3"]) assert.equal(parseAppKey(key), null, key);
  });

  it("a page's message names the app it is about", () => {
    assert.equal(appMessage({ name: "bench", version: "v2" }, " add a tab for the latest run's output "), 'About the app "bench" (v2, open in front of me): add a tab for the latest run\'s output');
  });
});
