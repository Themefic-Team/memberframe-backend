/**
 * A linked file's address, checked before the server fetches it. FP-12.
 *
 * A creator can point an asset at a file they host elsewhere (Google Drive,
 * Dropbox, their own CDN). MemberFrame fetches it and streams it on, so the
 * address stays private. Because the server does the fetching, the address
 * must not be able to reach this server's own network: https only, and every
 * address the host resolves to must be public.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class RemoteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteUrlError";
  }
}

/** Loopback, private, link-local, carrier-grade NAT, multicast, reserved. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/** Syntax only: https, a host name, no credentials. Used when a creator saves the link. */
export function checkRemoteUrlShape(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RemoteUrlError("Paste a full address starting with https://");
  }
  if (url.protocol !== "https:") throw new RemoteUrlError("The link must start with https://");
  if (url.username || url.password) throw new RemoteUrlError("The link must not contain a user name or password.");
  if (url.hostname === "localhost" || (isIP(url.hostname) && isPrivateAddress(url.hostname))) {
    throw new RemoteUrlError("The link must be a public address.");
  }
  return url.toString();
}

/** Shape plus DNS: every address the host resolves to must be public. Used before each fetch. */
export async function assertPublicUrl(value: string): Promise<URL> {
  const url = new URL(checkRemoteUrlShape(value));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new RemoteUrlError("The link's host could not be found.");
  if (addresses.some((entry) => isPrivateAddress(entry.address))) throw new RemoteUrlError("The link must be a public address.");
  return url;
}
