// ── The frame an app's page runs in (plans/apps.md §9) ─────────────────────
// Every app's document is the srcdoc of a sandboxed frame with an opaque
// origin (components/AppHost.tsx). What the frame lets it reach is the
// frame's `sandbox` tokens and its `allow` features (Permissions Policy),
// both read by the browser when the document is NAVIGATED to. Every app
// gets the same frame, games included; three features more — motion,
// camera, geolocation — only a version that declares them (`app.yaml`'s
// `permissions:`, src/apps/manifest.ts `DECLARED_PERMISSIONS`, read off its
// `dist/build.json`), so the host sets the attributes before the srcdoc and
// an earlier version's never carry over to the next. Pure: tested by
// ./frame-permissions.test.ts in the root run, which installs no
// web/node_modules.

/** What every app's frame gets for a game: `requestPointerLock()`, and
 *  `screen.orientation.lock()` (which needs fullscreen, below). */
export const GAME_SANDBOX = ["allow-pointer-lock", "allow-orientation-lock"] as const;
/** What every app's frame may use for a game: `requestFullscreen()`, the
 *  Gamepad API, `navigator.wakeLock.request("screen")`. Each needs a click
 *  or a visible page, and the browser shows its own way out of the first. */
export const GAME_ALLOW = ["fullscreen", "gamepad", "screen-wake-lock"] as const;

/** Every app's sandbox: scripts, saving a file it was handed, a form's
 *  submit event (the CSP's `form-action 'none'` still sends nothing), and
 *  the game's. Never `allow-same-origin`. */
export const BASE_SANDBOX = ["allow-scripts", "allow-downloads", "allow-forms", ...GAME_SANDBOX] as const;
/** Every app's features: the microphone and the clipboard (a Copy button),
 *  and the game's. None sends anything off the page. */
export const BASE_ALLOW = ["microphone", "clipboard-write", ...GAME_ALLOW] as const;

/** What each name a manifest may list adds to the frame. Its keys are the
 *  manifest's names, held equal to `APP_PERMISSIONS` by the test. `camera`
 *  and `geolocation` are MCP Apps' own, mapped as ext-apps'
 *  `buildAllowAttribute` maps them. */
export const FRAME_GRANTS: Readonly<Record<string, readonly string[]>> = {
  // `devicemotion` + `deviceorientation` (tilt): unprompted in Chrome, and
  // motion can be read to guess what a person types. No magnetometer, so
  // no compass heading (`deviceorientationabsolute`).
  motion: ["accelerometer", "gyroscope"],
  camera: ["camera"],
  geolocation: ["geolocation"],
  // Every app's already: accepted, and add nothing.
  fullscreen: [],
  "pointer-lock": [],
  gamepad: [],
  "wake-lock": [],
  microphone: [],
  "clipboard-write": [],
};

/** The names this host knows from a list read off a build.json: a name it
 *  does not know (a newer strut's, a peer's) grants nothing. */
export function knownPermissions(permissions: unknown): string[] {
  if (!Array.isArray(permissions)) return [];
  return Object.keys(FRAME_GRANTS).filter((p) => permissions.includes(p));
}

/** The policy features a version's permissions add to every app's, in the
 *  table's order and once each. A frame that holds the app's host page
 *  (the store's live preview of a publisher's page) adds these too, with
 *  the game's: a nested frame gets only what every frame above it has. */
export function declaredAllow(permissions?: unknown): string[] {
  const allow: string[] = [];
  for (const p of knownPermissions(permissions)) {
    for (const f of FRAME_GRANTS[p]!) if (!allow.includes(f)) allow.push(f);
  }
  return allow;
}

/** The app's frame's `sandbox` and `allow`: every app's, then the features
 *  the version declared. */
export function frameAttributes(permissions?: unknown): { sandbox: string; allow: string } {
  return { sandbox: BASE_SANDBOX.join(" "), allow: [...BASE_ALLOW, ...declaredAllow(permissions)].join("; ") };
}

/** MCP Apps' `McpUiResourcePermissions` (ext-apps), the shape a host reports
 *  what it granted in, as `hostCapabilities.sandbox.permissions`. */
export type McpPermissions = { camera?: {}; microphone?: {}; geolocation?: {}; clipboardWrite?: {} };

/** What the frame grants of MCP Apps' own four, for the page's
 *  `ui/initialize`: the microphone and the clipboard always, the camera and
 *  geolocation when the version declared them. */
export function mcpPermissions(permissions?: unknown): McpPermissions {
  const granted = knownPermissions(permissions);
  return {
    ...(granted.includes("camera") ? { camera: {} } : {}),
    microphone: {},
    ...(granted.includes("geolocation") ? { geolocation: {} } : {}),
    clipboardWrite: {},
  };
}

/** A STRANGER's page — another strut server's public app, hosted here
 *  (./remote-app, specs/API.md §17.9) — runs as a frame of THIS strut's
 *  page, so whatever the browser granted this origin (the microphone a
 *  person allowed for dictation) a feature in its `allow` would hand it
 *  unasked. It gets scripts, a form's submit event, the clipboard, pointer
 *  lock, the gamepad and the wake lock: no microphone, none of what its
 *  version declares, no download (a file saved from this origin), and no
 *  fullscreen (a page that could cover this host's own sheets) — with it no
 *  orientation lock, which needs fullscreen. */
export const STRANGER_SANDBOX = ["allow-scripts", "allow-forms", "allow-pointer-lock"] as const;
export const STRANGER_ALLOW = ["clipboard-write", "gamepad", "screen-wake-lock"] as const;

/** A stranger's frame: `STRANGER_SANDBOX`, `STRANGER_ALLOW`. */
export function strangerFrameAttributes(): { sandbox: string; allow: string } {
  return { sandbox: STRANGER_SANDBOX.join(" "), allow: STRANGER_ALLOW.join("; ") };
}

/** What a stranger's frame is granted of MCP Apps' four: the clipboard. */
export function strangerMcpPermissions(): McpPermissions {
  return { clipboardWrite: {} };
}
