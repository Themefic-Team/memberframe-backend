/**
 * Is a domain the creator typed a real, public, reachable site?
 *
 * Profile, Site Domains takes domains typed by the creator since the plugin no
 * longer reads them from Framer (Marketplace review, 2026-10-28). This catches
 * the common mistake, a typo, before it is saved: the name must resolve, to a
 * public address, and answer HTTPS. Whether the domain is really this site is
 * the other half (`originSightings.ts`), proven once a page there calls us
 * with this site's key.
 *
 * ## Server side request safety
 *
 * The server connects to an address a creator chose, so:
 *   - https only, port 443 only, and only to public addresses: loopback,
 *     private, link local, carrier grade NAT, and reserved ranges are refused;
 *   - the connection is pinned to the address that was checked, so a DNS
 *     answer cannot change between the check and the request (rebinding);
 *   - one HEAD request to `/`, no redirects followed, no body read, a short
 *     timeout.
 *
 * ## What the answer means
 *
 * `*.framer.app` resolves for any name, so resolving proves nothing about a
 * typo there: Framer answers 404 for a name with no site published (checked
 * 2026-10-28: a real site 200, a one letter typo 404, both from Framer). So:
 * below 400 is a site (a redirect too); 401 and 403 are a site behind a
 * password; 404 and 410 are no site published here; 5xx is unreachable.
 */

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export type DomainCheck = { ok: true } | { ok: false; reason: DomainProblem };
export type DomainProblem = "not_found" | "not_published" | "not_public" | "unreachable" | "port";

/** What an HTTP status on `/` says about the domain. */
export function statusVerdict(status: number | undefined): DomainCheck {
  if (status === undefined) return { ok: false, reason: "unreachable" };
  if (status === 404 || status === 410) return { ok: false, reason: "not_published" };
  if (status >= 500) return { ok: false, reason: "unreachable" };
  return { ok: true };
}

const TIMEOUT_MS = 6000;

function ipv4Public(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier grade NAT
  if (a === 169 && b === 254) return false; // link local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false; // IETF and documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast and reserved
  return true;
}

/** A public unicast address, not one inside a network or reserved. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return ipv4Public(address);
  if (version !== 6) return false;

  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Public(mapped[1]!);
  if (lower === "::" || lower === "::1") return false;
  if (/^f[cd]/.test(lower)) return false; // unique local
  if (/^fe[89ab]/.test(lower)) return false; // link local
  if (/^ff/.test(lower)) return false; // multicast
  return true;
}

export async function checkDomain(origin: string, timeoutMs: number = TIMEOUT_MS): Promise<DomainCheck> {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "unreachable" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "port" };

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (addresses.length === 0) return { ok: false, reason: "not_found" };
  if (!addresses.every((entry) => isPublicAddress(entry.address))) return { ok: false, reason: "not_public" };

  const target = addresses[0]!;
  return new Promise<DomainCheck>((resolve) => {
    const req = request(
      {
        host: url.hostname,
        servername: url.hostname,
        port: 443,
        method: "HEAD",
        path: "/",
        timeout: timeoutMs,
        headers: { "user-agent": "MemberFrame domain check" },
        // Pinned to the checked address. Node may ask for every address.
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options && options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        }) as never,
      },
      (response) => {
        response.resume();
        resolve(statusVerdict(response.statusCode));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "unreachable" });
    });
    req.on("error", () => resolve({ ok: false, reason: "unreachable" }));
    req.end();
  });
}
