import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appMessage, strutLink } from "./app-links";

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

  it("a page's message names the app it is about", () => {
    assert.equal(appMessage({ name: "bench", version: "v2" }, " add a tab for the latest run's output "), 'About the app "bench" (v2, open in front of me): add a tab for the latest run\'s output');
  });
});
