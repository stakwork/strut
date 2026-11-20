/**
 * The object store boundary: where strut keeps what it moves off its own
 * disk (plans/run-archive.md). One protocol, S3, and one client; an
 * S3-compatible store (MinIO, R2, …) is the same client with an endpoint.
 * `MemoryObjectStore` is the test implementation.
 *
 * Four calls and no listing: strut reads an object only by a key it
 * recorded when it wrote it, so a key scoped to one prefix needs no
 * `s3:ListBucket`.
 */
import { Readable } from "node:stream";

export interface ObjectStore {
  /** Store `body` under `key`, replacing what is there. Streamed: the
   *  body's length need not be known. */
  put(key: string, body: Readable): Promise<void>;
  /** The object's bytes. Rejects when there is none. */
  get(key: string): Promise<Readable>;
  /** The object's size, or null when there is none. */
  head(key: string): Promise<{ size: number } | null>;
  /** Remove the object. Nothing to remove is not an error. */
  delete(key: string): Promise<void>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    this.objects.set(key, Buffer.concat(chunks));
  }

  async get(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`no object "${key}"`);
    return Readable.from([object]);
  }

  async head(key: string): Promise<{ size: number } | null> {
    const object = this.objects.get(key);
    return object ? { size: object.length } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export interface S3Settings {
  bucket: string;
  /** Signs every request, a custom endpoint's included. */
  region: string;
  /** An S3-compatible store's URL. Unset: AWS S3. Addressed path-style
   *  (`<endpoint>/<bucket>/<key>`), which every such store serves. */
  endpoint?: string;
  /** A key pair. Unset: the SDK's default chain (an instance role). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

type S3Module = typeof import("@aws-sdk/client-s3");
type S3Client = import("@aws-sdk/client-s3").S3Client;

/** An S3 failure as one readable line. A HEAD's error has no body, so the
 *  SDK's own message for it is "UnknownError". */
function s3Error(action: string, key: string, err: unknown): Error {
  const e = err as { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  const what = [e.name, e.message || e.code].filter((part) => part && part !== "UnknownError" && part !== "Error").join(": ");
  return new Error(`S3 ${action} "${key}" failed${status ? ` (${status})` : ""}${what ? `: ${what}` : ""}`, { cause: err });
}

/**
 * The S3 implementation, on the AWS SDK. The SDK is loaded by the first
 * call, never at boot: a strut with no archive never loads it.
 */
export class S3ObjectStore implements ObjectStore {
  private loaded: Promise<{ s3: S3Module; client: S3Client }> | undefined;

  constructor(private readonly settings: S3Settings) {}

  private sdk(): Promise<{ s3: S3Module; client: S3Client }> {
    return (this.loaded ??= (async () => {
      const s3 = await import("@aws-sdk/client-s3");
      const { region, endpoint, credentials } = this.settings;
      const client = new s3.S3Client({
        region,
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        // No key pair: the SDK's default chain (env, shared config, a
        // container's or an instance's role).
        ...(credentials ? { credentials } : {}),
        // The SDK's default since v3.729 ("WHEN_SUPPORTED") adds a CRC32
        // checksum to every upload and asks for one on every download, which
        // several S3-compatible stores refuse or do not answer. None of the
        // calls made here requires one, and each transfer is checked by size
        // (`uploadLog`, `downloadLog` in run-archive.ts).
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        // The SDK's defaults wait forever on an endpoint that never answers.
        requestHandler: { connectionTimeout: 10_000, socketTimeout: 60_000 },
      });
      return { s3, client };
    })());
  }

  /** A multipart upload, so the length need not be known and nothing is
   *  written to disk first; a body under one part (5 MB) is a single PUT.
   *  A failed upload aborts its parts. */
  async put(key: string, body: Readable): Promise<void> {
    const [{ client }, { Upload }] = await Promise.all([this.sdk(), import("@aws-sdk/lib-storage")]);
    try {
      await new Upload({ client, params: { Bucket: this.settings.bucket, Key: key, Body: body } }).done();
    } catch (err) {
      throw s3Error("PUT", key, err);
    }
  }

  async get(key: string): Promise<Readable> {
    const { s3, client } = await this.sdk();
    try {
      const { Body } = await client.send(new s3.GetObjectCommand({ Bucket: this.settings.bucket, Key: key }));
      if (!(Body instanceof Readable)) throw new Error("no body");
      return Body;
    } catch (err) {
      throw s3Error("GET", key, err);
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    const { s3, client } = await this.sdk();
    try {
      const { ContentLength } = await client.send(new s3.HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }));
      return { size: ContentLength ?? 0 };
    } catch (err) {
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw s3Error("HEAD", key, err);
    }
  }

  async delete(key: string): Promise<void> {
    const { s3, client } = await this.sdk();
    try {
      await client.send(new s3.DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key }));
    } catch (err) {
      throw s3Error("DELETE", key, err);
    }
  }

  /** Close the client's sockets (a test's). */
  async close(): Promise<void> {
    (await this.loaded?.catch(() => undefined))?.client.destroy();
  }
}
