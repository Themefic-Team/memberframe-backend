/**
 * Where protected files live. FP-12.
 *
 * Two drivers behind one shape. `local` writes under `ASSET_STORAGE_DIR`; `s3`
 * writes to any S3 compatible bucket through `presignS3`. The key returned by
 * `put` is stored on the asset row and never leaves the server.
 *
 * Uploads arrive as a stream and are written to a temporary file first, so
 * the size is known and capped before anything reaches the bucket, and a
 * cancelled upload leaves nothing behind.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env.js";
import { presignS3, type S3Target } from "./s3Presign.js";

export class StorageError extends Error {
  constructor(
    readonly reason: "too_large" | "empty" | "storage_failed" | "missing",
    message: string
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StoredFile {
  storageKey: string;
  sizeBytes: number;
}

export interface FileStream {
  stream: Readable;
  sizeBytes: number | null;
}

function s3Target(): S3Target {
  return { ...env.assets.s3 };
}

function root(): string {
  return path.resolve(env.assets.localDir);
}

/** A path under the storage root, refusing anything that climbs out of it. */
function localPath(relative: string): string {
  const full = path.resolve(root(), relative);
  if (!full.startsWith(root() + path.sep)) throw new StorageError("missing", "Invalid storage key.");
  return full;
}

/** Copy a stream to a temporary file, stopping at `maxBytes`. */
async function spool(input: Readable, maxBytes: number): Promise<{ file: string; size: number }> {
  const tempDir = path.join(root(), ".incoming");
  await mkdir(tempDir, { recursive: true });
  const file = path.join(tempDir, randomBytes(16).toString("hex"));

  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new StorageError("too_large", `Files can be up to ${Math.floor(maxBytes / 1048576)} MB.`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(input, counter, createWriteStream(file));
  } catch (error) {
    await rm(file, { force: true });
    if (error instanceof StorageError) throw error;
    throw new StorageError("storage_failed", "The upload did not finish.");
  }

  if (size === 0) {
    await rm(file, { force: true });
    throw new StorageError("empty", "That file is empty.");
  }
  return { file, size };
}

/** Store an uploaded file for a site. */
export async function putFile(siteId: string, input: Readable, maxBytes = env.assets.maxBytes): Promise<StoredFile> {
  const { file, size } = await spool(input, maxBytes);
  const objectName = `${siteId}/${randomBytes(18).toString("hex")}`;

  try {
    if (env.assets.driver === "s3") {
      const url = presignS3(s3Target(), { method: "PUT", key: `assets/${objectName}`, expiresSeconds: 900 });
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Length": String(size), "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
        body: Readable.toWeb(createReadStream(file)) as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      if (!response.ok) {
        throw new StorageError("storage_failed", `The storage bucket refused the file (${response.status}).`);
      }
      return { storageKey: `s3:assets/${objectName}`, sizeBytes: size };
    }

    const target = localPath(objectName);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(file, target);
    return { storageKey: `local:${objectName}`, sizeBytes: size };
  } finally {
    await rm(file, { force: true });
  }
}

/** Open a stored file for streaming to a visitor. */
export async function openFile(storageKey: string): Promise<FileStream> {
  if (storageKey.startsWith("local:")) {
    const file = localPath(storageKey.slice("local:".length));
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new StorageError("missing", "The file is no longer stored.");
    return { stream: createReadStream(file), sizeBytes: info.size };
  }

  if (storageKey.startsWith("s3:")) {
    const url = presignS3(s3Target(), { method: "GET", key: storageKey.slice("s3:".length), expiresSeconds: 60 });
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new StorageError("missing", "The file is no longer stored.");
    const length = Number(response.headers.get("content-length"));
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      sizeBytes: Number.isFinite(length) && length > 0 ? length : null,
    };
  }

  throw new StorageError("missing", "Unknown storage key.");
}

/** Remove a stored file. Best effort: a missing file is already removed. */
export async function removeFile(storageKey: string): Promise<void> {
  if (storageKey.startsWith("local:")) {
    await rm(localPath(storageKey.slice("local:".length)), { force: true }).catch(() => undefined);
    return;
  }
  if (storageKey.startsWith("s3:")) {
    const url = presignS3(s3Target(), { method: "DELETE", key: storageKey.slice("s3:".length), expiresSeconds: 300 });
    await fetch(url, { method: "DELETE" }).catch(() => undefined);
  }
}
