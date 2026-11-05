// A turn's attached file, how it shows — tested by src/apps/jamie.test.ts:
// an image as a thumbnail, a text file to read in place, anything else a
// chip with its name.

export interface TurnAttachment {
  name: string;
  mediaType: string;
  size: number;
  /** Where the turn's run keeps it (`attachments/<name>`); absent on a turn
   *  read before strut said. */
  path?: string;
}

/** Images a browser draws, and nothing an image tag would run. */
const IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const TEXT_TYPE = /^(text\/|application\/(json|xml|x-yaml|yaml|csv))/i;
const TEXT_NAME = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|log|html?|css|js|ts|tsx|py|sh|sql)$/i;

export function attachmentShow(a: Pick<TurnAttachment, "name" | "mediaType" | "path">): "image" | "text" | "file" {
  if (!a.path) return "file";
  if (IMAGE.test(a.mediaType)) return "image";
  if (TEXT_TYPE.test(a.mediaType) || TEXT_NAME.test(a.name)) return "text";
  return "file";
}
