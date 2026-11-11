import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BASE_ALLOW, BASE_SANDBOX, FRAME_GRANTS, GAME_ALLOW, GAME_SANDBOX, declaredAllow, frameAttributes, knownPermissions, mcpPermissions, strangerFrameAttributes, strangerMcpPermissions } from "./frame-permissions";
import { APP_PERMISSIONS, DECLARED_PERMISSIONS } from "../../src/apps/manifest.js";

/** What an app's frame is granted (plans/apps.md §9): every app's — a
 *  game's included — plus motion, the camera or geolocation when its
 *  version declares them, nothing for a name the host does not know. */
describe("an app's frame", () => {
  const SANDBOX = "allow-scripts allow-downloads allow-forms allow-pointer-lock allow-orientation-lock";
  const ALLOW = "microphone; clipboard-write; fullscreen; gamepad; screen-wake-lock";

  it("knows exactly the names a manifest may list, and grants something for the declared three alone", () => {
    assert.deepEqual(Object.keys(FRAME_GRANTS), [...APP_PERMISSIONS]);
    assert.deepEqual(Object.keys(FRAME_GRANTS).filter((p) => FRAME_GRANTS[p]!.length), [...DECLARED_PERMISSIONS]);
  });

  it("every app gets the same frame, a game's features included — the string Hive and Peel copy", () => {
    assert.deepEqual(frameAttributes(), { sandbox: SANDBOX, allow: ALLOW });
    for (const none of [[], null, "motion", ["fullscreen", "pointer-lock", "gamepad", "wake-lock", "microphone", "clipboard-write"]]) {
      assert.deepEqual(frameAttributes(none), { sandbox: SANDBOX, allow: ALLOW }, JSON.stringify(none));
    }
    assert.equal(BASE_SANDBOX.includes("allow-same-origin" as never), false, "never the host's origin");
    assert.deepEqual([...GAME_SANDBOX], ["allow-pointer-lock", "allow-orientation-lock"]);
    assert.deepEqual([...GAME_ALLOW], ["fullscreen", "gamepad", "screen-wake-lock"]);
    assert.deepEqual([...BASE_ALLOW].slice(0, 2), ["microphone", "clipboard-write"]);
  });

  it("adds a declared feature to `allow`, never to the sandbox", () => {
    assert.deepEqual(frameAttributes(["motion"]), { sandbox: SANDBOX, allow: `${ALLOW}; accelerometer; gyroscope` });
    assert.equal(frameAttributes(["camera"]).allow, `${ALLOW}; camera`);
    assert.equal(frameAttributes(["geolocation"]).allow, `${ALLOW}; geolocation`);
  });

  it("the same set is the same attributes, whatever the order; an unknown name grants nothing", () => {
    assert.deepEqual(frameAttributes(["geolocation", "motion", "camera", "motion"]), frameAttributes(["camera", "motion", "geolocation"]));
    assert.equal(frameAttributes(["geolocation", "motion", "camera"]).allow, `${ALLOW}; accelerometer; gyroscope; camera; geolocation`);
    assert.deepEqual(frameAttributes(["motion", "vibrate", "allow-same-origin", 7]), frameAttributes(["motion"]));
    assert.deepEqual(knownPermissions(["camera", "teleport", "motion"]), ["motion", "camera"]);
  });

  it("what a version adds alone, for a frame above the app's (the store's preview of a publisher's page)", () => {
    assert.deepEqual(declaredAllow(), []);
    assert.deepEqual(declaredAllow(["fullscreen", "gamepad"]), []);
    assert.deepEqual(declaredAllow(["geolocation", "motion"]), ["accelerometer", "gyroscope", "geolocation"]);
  });

  it("reports MCP Apps' own four as the page's ui/initialize names them", () => {
    assert.deepEqual(mcpPermissions(), { microphone: {}, clipboardWrite: {} });
    assert.deepEqual(mcpPermissions(["motion", "geolocation", "camera"]), { camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} });
  });

  it("a stranger's page (another server's public app, hosted here) gets no microphone and nothing it declares", () => {
    const a = strangerFrameAttributes();
    assert.equal(a.sandbox, SANDBOX, "every app's sandbox, never allow-same-origin");
    assert.equal(a.allow, "clipboard-write; fullscreen; gamepad; screen-wake-lock");
    for (const f of ["microphone", "camera", "geolocation", "accelerometer", "gyroscope"]) assert.ok(!a.allow.includes(f), f);
    assert.deepEqual(strangerMcpPermissions(), { clipboardWrite: {} });
  });
});
