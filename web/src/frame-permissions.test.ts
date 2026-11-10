import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BASE_ALLOW, BASE_SANDBOX, FRAME_GRANTS, frameAttributes, frameGrants, knownPermissions, mcpPermissions } from "./frame-permissions";
import { APP_PERMISSIONS } from "../../src/apps/manifest.js";

/** What an app's frame is granted from its version's `permissions`
 *  (plans/apps.md §9): every app's attributes, plus what each declared name
 *  adds, nothing for a name the host does not know. */
describe("an app's frame", () => {
  it("knows exactly the names a manifest may declare", () => {
    assert.deepEqual(Object.keys(FRAME_GRANTS), [...APP_PERMISSIONS]);
  });

  it("every app gets scripts, downloads, forms, the microphone and the clipboard, and nothing more", () => {
    const base = { sandbox: "allow-scripts allow-downloads allow-forms", allow: "microphone; clipboard-write" };
    assert.deepEqual(frameAttributes(), base);
    assert.deepEqual(frameAttributes([]), base);
    assert.deepEqual(frameAttributes(null), base);
    assert.deepEqual(frameAttributes("fullscreen"), base, "not a list: nothing granted");
    assert.deepEqual(frameAttributes(["microphone", "clipboard-write"]), base, "every app's already: no change");
    assert.equal(BASE_SANDBOX.includes("allow-same-origin" as never), false, "never the host's origin");
    assert.deepEqual([...BASE_ALLOW], ["microphone", "clipboard-write"]);
  });

  it("maps each declared permission to its sandbox token or policy feature", () => {
    const one = (p: string) => frameAttributes([p]);
    assert.deepEqual(one("pointer-lock"), { sandbox: "allow-scripts allow-downloads allow-forms allow-pointer-lock", allow: "microphone; clipboard-write" });
    assert.deepEqual(one("fullscreen"), { sandbox: "allow-scripts allow-downloads allow-forms allow-orientation-lock", allow: "microphone; clipboard-write; fullscreen" });
    assert.equal(one("gamepad").allow, "microphone; clipboard-write; gamepad");
    assert.equal(one("motion").allow, "microphone; clipboard-write; accelerometer; gyroscope");
    assert.equal(one("wake-lock").allow, "microphone; clipboard-write; screen-wake-lock");
    assert.equal(one("camera").allow, "microphone; clipboard-write; camera");
    assert.equal(one("geolocation").allow, "microphone; clipboard-write; geolocation");
    for (const p of ["gamepad", "motion", "wake-lock", "camera", "geolocation"]) assert.equal(one(p).sandbox, "allow-scripts allow-downloads allow-forms", p);
  });

  it("the same set is the same attributes, whatever the order; an unknown name grants nothing", () => {
    const a = frameAttributes(["wake-lock", "pointer-lock", "fullscreen", "motion", "fullscreen"]);
    const b = frameAttributes(["fullscreen", "motion", "pointer-lock", "wake-lock"]);
    assert.deepEqual(a, b);
    assert.deepEqual(a, {
      sandbox: "allow-scripts allow-downloads allow-forms allow-orientation-lock allow-pointer-lock",
      allow: "microphone; clipboard-write; fullscreen; accelerometer; gyroscope; screen-wake-lock",
    });
    assert.deepEqual(frameAttributes(["fullscreen", "vibrate", "allow-same-origin", 7]), frameAttributes(["fullscreen"]));
    assert.deepEqual(knownPermissions(["camera", "teleport", "fullscreen"]), ["fullscreen", "camera"]);
  });

  it("what a version adds alone, for a frame above the app's (the store's preview of a publisher's page)", () => {
    assert.deepEqual(frameGrants(), { sandbox: [], allow: [] });
    assert.deepEqual(frameGrants(["microphone", "clipboard-write"]), { sandbox: [], allow: [] });
    assert.deepEqual(frameGrants(["pointer-lock", "fullscreen", "gamepad"]), { sandbox: ["allow-orientation-lock", "allow-pointer-lock"], allow: ["fullscreen", "gamepad"] });
  });

  it("reports MCP Apps' own four as the page's ui/initialize names them", () => {
    assert.deepEqual(mcpPermissions(), { microphone: {}, clipboardWrite: {} });
    assert.deepEqual(mcpPermissions(["fullscreen", "geolocation", "camera"]), { camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} });
  });
});
