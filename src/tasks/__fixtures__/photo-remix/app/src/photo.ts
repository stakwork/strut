import type { TaskReplyFile, WorkerHistoryItem } from "@strut/kit";

/** The task type this app draws: a standing one, so a picture is wanted whenever the worker asks. */
export const TYPE = "photo-remix";
/** How often the page reads the worker's history while a picture is being made. */
export const REPLY_POLL_MS = 3_000;
/** How long it waits for one, as strut/tasks does: a model answers well before. */
export const REPLY_WAIT_MS = 120_000;

/** msat as a worker reads it. */
export const sats = (msat: number) => {
  const n = Math.floor(msat / 1000);
  return `${n.toLocaleString("en-US")} ${n === 1 ? "sat" : "sats"}`;
};

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^\w+: /, "");

/** What came of a picture, read off the workflow's reply: the result first, then the photo; or `failed`. */
export type Outcome =
  | { state: "waiting" }
  | { state: "failed"; title: string; photo?: TaskReplyFile }
  | { state: "done"; after: TaskReplyFile; before?: TaskReplyFile };

export function outcomeOf(item: WorkerHistoryItem): Outcome {
  const reply = item.reply;
  if (!reply) return { state: "waiting" };
  const pictures = (reply.files ?? []).filter((f) => f.mediaType.startsWith("image/"));
  if (reply.show?.["failed"] || !pictures.length) {
    const title = typeof reply.show?.["title"] === "string" ? (reply.show["title"] as string) : "This one could not be transformed.";
    return { state: "failed", title, ...(pictures[0] ? { photo: pictures[0] } : {}) };
  }
  return { state: "done", after: pictures[0]!, ...(pictures[1] ? { before: pictures[1] } : {}) };
}

/** A photo chosen from the device as the host's camera takes one: a JPEG at most 1600 px on its longest side. */
export async function shrink(file: File, side = 1600): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (blob) return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } catch {
    // Not drawable here: sent as it is, and the answer's own caps decide.
  }
  return file;
}
