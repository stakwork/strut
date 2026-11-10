// ── The frame an app's page runs in (plans/apps.md §9) ─────────────────────
// Every app's document is the srcdoc of a sandboxed frame with an opaque
// origin (components/AppHost.tsx). What the frame lets it reach is the
// frame's `sandbox` tokens and its `allow` features (Permissions Policy),
// both read by the browser when the document is NAVIGATED to — so the host
// sets them from the version's `permissions` (its `dist/build.json`,
// `app.yaml`'s `permissions:`, src/apps/manifest.ts `APP_PERMISSIONS`)
// before it sets the srcdoc, and an earlier version's grants never carry
// over to the next. Pure: tested by ./frame-permissions.test.ts in the root
// run, which installs no web/node_modules.

/** What every app's frame gets: scripts, saving a file it was handed, a
 *  form's submit event (the CSP's `form-action 'none'` still sends nothing). */
export const BASE_SANDBOX = ["allow-scripts", "allow-downloads", "allow-forms"] as const;
/** What every app's frame may use: the microphone and the clipboard (a Copy
 *  button). Neither sends anything off the page. */
export const BASE_ALLOW = ["microphone", "clipboard-write"] as const;

/** What each declared permission adds to the frame. Its keys are the
 *  manifest's names, held equal to `APP_PERMISSIONS` by the test. The MCP
 *  Apps names (`camera`, `geolocation`, `microphone`, `clipboard-write`) map
 *  to the features ext-apps' `buildAllowAttribute` gives them. */
export const FRAME_GRANTS: Readonly<Record<string, { sandbox?: readonly string[]; allow?: readonly string[] }>> = {
  // `requestFullscreen()`; `screen.orientation.lock()`, which needs fullscreen.
  fullscreen: { allow: ["fullscreen"], sandbox: ["allow-orientation-lock"] },
  // `requestPointerLock()`: a sandbox token, there is no policy feature.
  "pointer-lock": { sandbox: ["allow-pointer-lock"] },
  gamepad: { allow: ["gamepad"] },
  // `devicemotion` + `deviceorientation`; no magnetometer, so no compass
  // heading (`deviceorientationabsolute`).
  motion: { allow: ["accelerometer", "gyroscope"] },
  "wake-lock": { allow: ["screen-wake-lock"] },
  camera: { allow: ["camera"] },
  geolocation: { allow: ["geolocation"] },
  // Every app's already.
  microphone: {},
  "clipboard-write": {},
};

/** The names this host knows from a list read off a build.json: a name it
 *  does not know (a newer strut's, a peer's) grants nothing. */
export function knownPermissions(permissions: unknown): string[] {
  if (!Array.isArray(permissions)) return [];
  return Object.keys(FRAME_GRANTS).filter((p) => permissions.includes(p));
}

/** What a version's permissions add to every app's frame: the sandbox
 *  tokens and policy features, in the table's order and once each, so the
 *  same set is the same attributes. A frame that holds the app's host page
 *  (the store's live preview of a publisher's page) adds these too: a
 *  nested frame gets only what every frame above it was granted. */
export function frameGrants(permissions?: unknown): { sandbox: string[]; allow: string[] } {
  const sandbox: string[] = [];
  const allow: string[] = [];
  for (const p of knownPermissions(permissions)) {
    for (const t of FRAME_GRANTS[p]!.sandbox ?? []) if (!sandbox.includes(t)) sandbox.push(t);
    for (const f of FRAME_GRANTS[p]!.allow ?? []) if (!allow.includes(f) && !(BASE_ALLOW as readonly string[]).includes(f)) allow.push(f);
  }
  return { sandbox, allow };
}

/** The app's frame's `sandbox` and `allow` for a version's permissions:
 *  every app's, then what the version declared. */
export function frameAttributes(permissions?: unknown): { sandbox: string; allow: string } {
  const grants = frameGrants(permissions);
  return { sandbox: [...BASE_SANDBOX, ...grants.sandbox].join(" "), allow: [...BASE_ALLOW, ...grants.allow].join("; ") };
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
