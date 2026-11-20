// The Screenshots section's pure parts (components/AppScreenshots.tsx),
// tested by app-screenshots.test.ts. The limits are the manifest's
// (src/apps/manifest.ts), which the server checks again.

export const SCREENSHOTS_MAX = 8;
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The sizes a screenshot is taken at: a laptop's window and a phone's. */
export const SHOT_VIEWPORTS = {
  desktop: { label: "Desktop", size: { width: 1280, height: 800 } },
  phone: { label: "Phone", size: { width: 390, height: 844 } },
} as const;
export type ShotViewport = keyof typeof SHOT_VIEWPORTS;

/** The newest version of an app: what a save builds on, so a held app's drafts are kept. */
export function newestVersion(versions: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  for (const v of Object.keys(versions)) {
    const n = Number(v.slice(1));
    if (/^v\d+$/.test(v) && (!best || n > Number(best.slice(1)))) best = v;
  }
  return best;
}

/** What a save made, in a line. */
export function savedNote(saved: { version: string; changed: boolean; live: boolean; liveVersion?: string }): string {
  if (!saved.changed) return `That list is exactly ${saved.version}'s, so no new version was made${saved.live ? `: ${saved.version} is live again` : ""}.`;
  return saved.live
    ? `Saved as ${saved.version}, now live.`
    : `Saved as ${saved.version}, a draft: ${saved.liveVersion ?? "the held version"} stays live until you make ${saved.version} live below.`;
}
