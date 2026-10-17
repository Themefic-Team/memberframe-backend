/**
 * AWS Signature Version 4, query-string form, for S3 compatible storage.
 * FP-12.
 *
 * Hand written like the gateway adapters (`services/payments/*.ts`), so the
 * vault adds no SDK: one function, tested against AWS's own published example
 * (`test/assets.test.ts`). Works for AWS S3, Cloudflare R2 (region `auto`),
 * Backblaze B2 and MinIO.
 *
 * Every URL made here is used by this server only. A visitor never receives
 * one: downloads stream through `/api/assets/download/:token`, so the bucket
 * and the object key stay out of every client response (PRD S5).
 */

import { createHash, createHmac } from "node:crypto";

export interface S3Target {
  /** https://s3.eu-west-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, ... */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignInput {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  key: string;
  expiresSeconds: number;
  now?: Date;
}

/** RFC 3986 encoding, which is what SigV4 canonicalizes with. */
function encode(value: string, keepSlash = false): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, "/");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function amzDate(now: Date): { long: string; short: string } {
  const long = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { long, short: long.slice(0, 8) };
}

/**
 * Where an object lives. AWS endpoints use the bucket as a subdomain, which
 * new AWS buckets require. Everything else (R2, B2, MinIO) takes the bucket
 * as the first path segment.
 */
export function objectLocation(target: S3Target, key: string): { host: string; path: string; origin: string } {
  const endpoint = new URL(target.endpoint);
  const objectPath = `/${encode(key, true)}`;
  if (/(^|\.)amazonaws\.com$/.test(endpoint.hostname)) {
    const host = `${target.bucket}.${endpoint.host}`;
    return { host, path: objectPath, origin: `${endpoint.protocol}//${host}` };
  }
  return { host: endpoint.host, path: `/${encode(target.bucket)}${objectPath}`, origin: `${endpoint.protocol}//${endpoint.host}` };
}

/** A presigned URL for one object and one method, valid `expiresSeconds`. */
export function presignS3(target: S3Target, input: PresignInput): string {
  const { long, short } = amzDate(input.now ?? new Date());
  const location = objectLocation(target, input.key);
  const scope = `${short}/${target.region}/s3/aws4_request`;

  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${target.accessKeyId}/${scope}`],
    ["X-Amz-Date", long],
    ["X-Amz-Expires", String(input.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    input.method,
    location.path,
    canonicalQuery,
    `host:${location.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    long,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, short), target.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return `${location.origin}${location.path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
