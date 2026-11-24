import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appKey, appMessage, appPageAddress, appToolInput, frameableHold, holdAddress, holdNavigation, isPreviewVersion, namesApp, pageOpen, panelTarget, parseAppKey, peerAppLink, publicAppHop, soloPageAddress, soloTheme, strutLink } from "./app-links";
import { appLink } from "../../kit/src/links";

/** The pure parts of the app host's relay (./app-links, what ./app-host
 *  decides without the bridge): where a link leads, what a page's message
 *  becomes. The bridge itself is ext-apps'. */
describe("the app host", () => {
  it("the standalone page's &theme= is light or dark, else none (strut's UI is dark)", () => {
    assert.equal(soloTheme("light"), "light");
    assert.equal(soloTheme("dark"), "dark");
    assert.equal(soloTheme("Light"), undefined);
    assert.equal(soloTheme(null), undefined);
  });

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

  it("an app's page address is this UI's page with ?app=<key> alone", () => {
    assert.equal(appPageAddress("https://strut.test/?app=strut%2Fjamie&input=session%3Dx&lang=es#top", "strut/jamie"), "https://strut.test/?app=strut%2Fjamie");
    assert.equal(appPageAddress("https://swarm.test/lab/?wf=bench", "@peer/bench"), "https://swarm.test/lab/?app=%40peer%2Fbench");
  });

  it("a peer's page names apps on that peer; its other links are the peer's", () => {
    assert.deepEqual(peerAppLink({ app: "bench", input: "view=%2Fruns" }, "acme"), { app: "@acme/bench", input: "view=%2Fruns" });
    assert.deepEqual(peerAppLink({ app: "hive/ui" }, "acme"), { app: "@acme/hive/ui" });
    assert.equal(peerAppLink({ wf: "clip", run: "1" }, "acme"), null);
    assert.equal(peerAppLink({ app: "@other/bench" }, "acme"), null, "the peer's own peer");
    // A file the peer serves is read through it, a hop further when it is
    // already behind the peer's own.
    assert.deepEqual(peerAppLink({ artifact: "/jobs/j1/files/report.html" }, "acme"), { artifact: "/peers/acme/jobs/j1/files/report.html" });
    assert.deepEqual(peerAppLink({ artifact: "/artifacts/17/out.pdf" }, "acme"), { artifact: "/peers/acme/artifacts/17/out.pdf" });
    assert.deepEqual(peerAppLink({ artifact: "/peers/web/jobs/j1/files/a.png" }, "acme"), { artifact: "/peers/acme/peers/web/jobs/j1/files/a.png" });
    assert.equal(peerAppLink({ artifact: "/secrets" }, "acme"), null, "not a served file");
    assert.equal(peerAppLink({ artifact: "https://elsewhere.test/x.html" }, "acme"), null);
  });

  it("a file or another app opens in the side panel; the app on screen and everything else are the host's", () => {
    const bench = { name: "bench", version: "v3" };
    const here = { origin: "https://strut.test", pathname: "/" };
    const link = (url: string) => strutLink(url, here)!;
    // A served file: a job's, a run's, a peer's through the read-through.
    assert.deepEqual(panelTarget(link("?artifact=%2Fjobs%2Fj1%2Ffiles%2Freport.html"), [bench]), { artifact: "/jobs/j1/files/report.html" });
    assert.deepEqual(panelTarget(link("?artifact=/artifacts/17/clip.mp4"), [bench]), { artifact: "/artifacts/17/clip.mp4" });
    assert.deepEqual(panelTarget(link("?artifact=/peers/acme/jobs/j1/files/a.pdf"), [bench]), { artifact: "/peers/acme/jobs/j1/files/a.pdf" });
    // Another app, here or a peer's, with what it is opened with.
    assert.deepEqual(panelTarget(link("?app=strut%2Fviews&input=view%3Dgallery"), [bench]), { app: "strut/views", input: "view=gallery" });
    assert.deepEqual(panelTarget(link("?app=@acme/hive/ui"), [bench]), { app: "@acme/hive/ui" });
    // The app on screen: its input, in place — the host's, not the panel's.
    assert.equal(panelTarget(link("?app=bench&input=run%3D1"), [bench]), null);
    assert.equal(panelTarget({ app: "bench@v3" }, [bench]), null);
    assert.deepEqual(panelTarget({ app: "bench@v2" }, [bench]), { app: "bench@v2" }, "another version is another page");
    // From the panel, its own app is on screen too.
    assert.equal(panelTarget({ app: "strut/views" }, [{ name: "strut/views", version: "v1" }, bench]), null);
    // What a job holds at an address: the job and the kind, never an address.
    assert.deepEqual(panelTarget(link("?job=j%201&hold=pod"), [bench]), { job: "j 1", hold: "pod" });
    assert.equal(panelTarget(link("?hold=pod"), [bench]), null, "a hold names its job");
    // Workflows, runs, jobs: as before the panel.
    for (const url of ["?wf=clip", "?wf=clip&run=12", "?job=j1"]) assert.equal(panelTarget(link(url), [bench]), null, url);
    // Nothing strut serves as a file.
    for (const path of ["/secrets", "/jobs/j1", "/jobs/j1/files/../../secrets", "https://elsewhere.test/a.html", "/artifacts/1/a?key=k"]) {
      assert.equal(panelTarget({ artifact: path }, [bench]), null, path);
    }
    assert.equal(panelTarget({ app: "@acme" }, [bench]), null, "a key that names nothing");
  });

  it("an app link with open=page is the host's to open as the page, never the panel's", () => {
    const bench = { name: "bench", version: "v3" };
    const params = strutLink(appLink("strut/jamie", { session: "ann/abc" }, { open: "page" }), here)!;
    assert.deepEqual(params, { app: "strut/jamie", input: "session=ann%2Fabc", open: "page" }, "the kit's link, read by the host");
    assert.equal(panelTarget(params, [bench]), null);
    assert.deepEqual(pageOpen(params), { app: "strut/jamie", input: "session=ann%2Fabc" });
    assert.deepEqual(pageOpen({ app: "@acme/hive/ui", open: "page" }), { app: "@acme/hive/ui" }, "a peer's, a plain open");
    // Without it, the same link opens beside the page, as before.
    assert.deepEqual(panelTarget(strutLink(appLink("strut/jamie", { session: "ann/abc" }), here)!, [bench]), { app: "strut/jamie", input: "session=ann%2Fabc" });
    for (const p of [{ app: "strut/jamie" }, { app: "strut/jamie", open: "panel" }, { open: "page" }, { app: "@acme", open: "page" }, { wf: "clip", open: "page" }]) {
      assert.equal(pageOpen(p), null, JSON.stringify(p));
    }
    // A file or a job's hold still opens beside the page.
    assert.deepEqual(panelTarget({ artifact: "/artifacts/1/a.png", open: "page" }, [bench]), { artifact: "/artifacts/1/a.png" });
    // A peer's page asks the same of its apps.
    assert.deepEqual(peerAppLink({ app: "bench", open: "page" }, "acme"), { app: "@acme/bench", open: "page" });
  });

  it("alone with no host to ask, the page goes to that app's page itself", () => {
    const solo = "https://strut.test/?app=strut%2Fcode&solo=1&theme=light&input=repo%3Dx";
    assert.equal(soloPageAddress(solo, { app: "strut/jamie", input: "session=ann%2Fabc" }), "https://strut.test/?app=strut%2Fjamie&solo=1&theme=light&input=session%3Dann%252Fabc");
    assert.equal(soloPageAddress(solo, { app: "strut/jamie" }), "https://strut.test/?app=strut%2Fjamie&solo=1&theme=light", "a plain open");
    assert.equal(soloPageAddress("https://swarm.test/lab/?app=bench&solo=1", { app: "@acme/hive/ui" }), "https://swarm.test/lab/?app=%40acme%2Fhive%2Fui&solo=1");
  });


  it("a job's hold is framed at an http(s) address on another origin, never this page's", () => {
    const here = "https://box.stakwork.ai";
    const pod = "https://p1a2b3-3000.stakwork.bot/_pods/open/tok";
    assert.equal(frameableHold(pod, here), pod);
    assert.equal(frameableHold("http://p1-3000.pods.localhost:4600/_pods/open/t", "http://localhost:3000"), "http://p1-3000.pods.localhost:4600/_pods/open/t");
    assert.equal(frameableHold(undefined, here), null, "the hold is gone");
    assert.equal(frameableHold("https://box.stakwork.ai/secrets", here), null, "this page's origin");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "/relative", "not a url"]) assert.equal(frameableHold(url, here), null, url);
  });

  const hold = "https://p1a2b3-3000.pods.stakwork.ai/_pods/open/tok3n";
  const pod = "https://p1a2b3-3000.pods.stakwork.ai";

  it("a hold's address bar shows its origin, never the sign-in link's token; an address typed since as it is", () => {
    assert.equal(holdAddress(hold), `${pod}/`);
    assert.equal(holdAddress(hold, hold), `${pod}/`, "back at the hold's own address");
    assert.equal(holdAddress(hold, `${pod}/settings?tab=1`), `${pod}/settings?tab=1`);
    assert.equal(holdAddress("not a url"), "");
  });

  it("an address typed in a hold's panel: its own origin in the frame, any other http(s) address in a tab, nothing else anywhere", () => {
    for (const [input, at] of [
      ["/settings", `${pod}/settings`],
      ["settings?tab=1", `${pod}/settings?tab=1`],
      ["  /a/b#c  ", `${pod}/a/b#c`],
      [`${pod}/x`, `${pod}/x`],
      [`${pod}/`, `${pod}/`],
      [hold, hold],
    ]) assert.deepEqual(holdNavigation(input!, hold), { frame: at }, input);
    for (const [input, at] of [
      ["https://github.com/stakwork", "https://github.com/stakwork"],
      ["github.com/stakwork", "https://github.com/stakwork"],
      ["localhost:3000/x", "http://localhost:3000/x"],
      ["//evil.test/x", "https://evil.test/x"],
      ["\\\\evil.test/x", "https://evil.test/x"],
      ["http://p1a2b3-3000.pods.stakwork.ai/x", "http://p1a2b3-3000.pods.stakwork.ai/x"],
      ["https://p1a2b3-3000.pods.stakwork.ai.evil.test/", "https://p1a2b3-3000.pods.stakwork.ai.evil.test/"],
      ["https://p1a2b3-3000.pods.stakwork.ai@evil.test/", "https://p1a2b3-3000.pods.stakwork.ai@evil.test/"],
    ]) assert.deepEqual(holdNavigation(input!, hold), { tab: at }, input);
    for (const input of ["", "   ", "javascript:alert(1)", "JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "mailto:a@b.test", "file:///etc/passwd", "ftp://x.test/"]) {
      assert.equal(holdNavigation(input, hold), null, input);
    }
    assert.equal(holdNavigation("/x", "not a url"), null, "no hold, nowhere");
  });

  it("the job's other addresses (a pod's other frontend) load in the frame too; the rest still opens in a tab", () => {
    const admin = "https://p1a2b3-5173.pods.stakwork.ai/_pods/open/tok5n";
    const also = [hold, admin, "not a url"];
    assert.deepEqual(holdNavigation("p1a2b3-5173.pods.stakwork.ai/users", hold, also), { frame: "https://p1a2b3-5173.pods.stakwork.ai/users" });
    assert.deepEqual(holdNavigation(admin, hold, also), { frame: admin });
    assert.deepEqual(holdNavigation("/settings", hold, also), { frame: `${pod}/settings` }, "a path is still the hold's own");
    assert.deepEqual(holdNavigation("https://p1a2b3-8000.pods.stakwork.ai/", hold, also), { tab: "https://p1a2b3-8000.pods.stakwork.ai/" }, "a port the job holds no address for");
    assert.equal(holdNavigation("javascript:alert(1)", hold, also), null);
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

  it("a key may name a preview, an unpublished build app/look hosts", () => {
    assert.deepEqual(parseAppKey("bench@preview-0123456789ab"), { name: "bench", version: "preview-0123456789ab" });
    assert.equal(isPreviewVersion("preview-0123456789ab"), true);
    for (const v of ["v3", "preview-xyz", undefined]) assert.equal(isPreviewVersion(v), false, String(v));
    assert.equal(parseAppKey("bench@preview-1"), null);
  });

  it("on a visitor's page, another public app opens in place: solo, public and theme kept, back to where it came from", () => {
    const page = "https://strut.test/?app=strut%2Fworker&solo=1&public=1&theme=light";
    const hop = new URL(publicAppHop({ app: "call-guide", input: "type=call-shop" }, "strut/worker", page)!);
    assert.deepEqual(Object.fromEntries(hop.searchParams), { app: "call-guide", solo: "1", public: "1", theme: "light", input: "type=call-shop", back: "strut/worker" });
    const home = new URL(publicAppHop({ app: "strut/worker" }, "call-guide", hop.href, { back: false })!);
    assert.deepEqual(Object.fromEntries(home.searchParams), { app: "strut/worker", solo: "1", public: "1", theme: "light" }, "Back drops the input and the back");
    assert.equal(publicAppHop({ app: "strut/worker" }, "strut/worker", page), null, "this app itself is the page's own link");
    assert.equal(publicAppHop({ app: "@acme/guide" }, "strut/worker", page), null, "a peer's app is not this public view's");
    assert.equal(publicAppHop({ app: "guide@v2" }, "strut/worker", page), null, "nor a pinned version");
    assert.equal(publicAppHop({ wf: "x" }, "strut/worker", page), null);
  });

  it("a page's message names the app it is about", () => {
    assert.equal(appMessage({ name: "bench", version: "v2" }, " add a tab for the latest run's output "), 'About the app "bench" (v2, open in front of me): add a tab for the latest run\'s output');
  });
});
