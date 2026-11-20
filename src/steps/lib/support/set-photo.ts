import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { bytesOf, PHOTO_MAX_BYTES, sphinxOf, supportDb } from "./_shared.js";

/**
 * `support/set-photo` (plans/people-and-hosts.md §5): Support's picture,
 * through the daemon (`PUT /dm/photo`), which sends it as `img` on every
 * message so a worker tells this Support from another box's. Strut keeps the
 * bytes in settings to show them: the page cannot load the memes URL.
 * `photo: null` clears it.
 */
export default defineStep({
  type: "support/set-photo",
  effect: "write",
  description: "Set Support's picture: { photo: { base64, type } } (jpeg, png, webp or gif, at most 1 MiB; the page sends a 512 px JPEG), or { photo: null } to clear it. Answers { url }.",
  input: z.object({ photo: z.object({ base64: z.string(), type: z.string() }).nullable() }),
  output: z.object({ url: z.string().nullable() }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const sphinx = sphinxOf(ctx, "support/set-photo");
    const db = await supportDb(ctx, "support/set-photo");
    if (cfg.photo === null) {
      await sphinx.setPhoto(null);
      db.prepare("UPDATE settings SET photo = NULL, photo_type = NULL, photo_url = NULL, photo_at = ? WHERE id = 1").run(Date.now());
      return { url: null };
    }
    const type = cfg.photo.type.toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new Error("bad_request: type is the picture's: image/jpeg, image/png, image/webp or image/gif");
    const bytes = bytesOf(cfg.photo.base64, PHOTO_MAX_BYTES, "the picture");
    const { url } = await sphinx.setPhoto({ data: bytes.toString("base64"), type });
    db.prepare("UPDATE settings SET photo = ?, photo_type = ?, photo_url = ?, photo_at = ? WHERE id = 1").run(bytes, type, url, Date.now());
    return { url };
  },
});
