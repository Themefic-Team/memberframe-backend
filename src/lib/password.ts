/**
 * Password hashing.
 *
 * CONFLICT C23, recorded rather than decided quietly: the backend PRD and
 * FP-02 both say Argon2id, and this uses scrypt from `node:crypto`.
 *
 * Why. Argon2id in Node means the `argon2` package, which is a native addon
 * requiring node-gyp. On Windows that needs Visual Studio build tools, and the
 * failure mode is an `npm install` that dies on a machine where it worked last
 * month because Node moved a minor version. For a surface that handles
 * passwords, a dependency tree of zero beats one that sometimes compiles.
 *
 * scrypt is not a downgrade in kind. It is a memory-hard KDF from the same
 * family, it is in Node's standard library with no addon, OWASP lists it as an
 * acceptable choice where Argon2id is unavailable, and it has no silent
 * truncation ceiling of the sort that makes bcrypt wrong here (conflict C15).
 *
 * It IS weaker than Argon2id against a GPU attacker with a large budget. The
 * upgrade path is this file and nothing else: `hash` writes an algorithm tag
 * into every stored string, and `verify` dispatches on it, so adding argon2id
 * later rehashes members on their next sign-in with no migration and no
 * forced reset. `needsRehash` is what drives that.
 *
 * Stored format, one line, self-describing:
 *
 *   scrypt$N=16384,r=8,p=1$<salt base64>$<hash base64>
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * `promisify` picks the three-argument overload and drops the one that takes
 * cost parameters, so the options object would be silently ignored and every
 * hash would use Node defaults. Typed explicitly to keep the fourth argument.
 */
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions
) => Promise<Buffer>;

/**
 * Cost parameters.
 *
 * N=16384 (2^14), r=8, p=1 uses about 16 MiB per hash and takes roughly 50 to
 * 100 ms on a modern core. The memory figure is the one that matters: it is
 * what makes parallel cracking expensive.
 *
 * Node's default `maxmem` is 32 MiB, and scrypt needs roughly 128 * N * r
 * bytes, so N=16384 sits at about 16 MiB and fits. Raising N to 2^15 exceeds
 * the default and throws, which is why `maxmem` is passed explicitly below
 * rather than left to chance.
 */
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

/**
 * A dummy hash, used to spend the same time on an address that does not exist.
 *
 * Generated once at module load from random bytes, so it can never match
 * anything. See `verifyAgainstNothing`.
 */
let dummyHash: string | null = null;

// ============================================================================
// HASHING
// ============================================================================

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);

  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAX_MEM,
  })) as Buffer;

  return [
    "scrypt",
    `N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}`,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Does this password match this stored hash?
 *
 * Returns false rather than throwing on a malformed stored value. A row with a
 * corrupt hash must fail closed: throwing would turn it into a 500, and a 500
 * on sign-in tells an attacker that this particular address is interesting.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;

  try {
    const derived = (await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    })) as Buffer;

    // Constant time. A byte-by-byte comparison that returns early leaks how
    // much of the hash matched, which is enough to attack it offline.
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * Spend the time a real verification would, and fail.
 *
 * This is the whole defence against a timing oracle on sign-in. Without it,
 * an unknown address returns in under a millisecond while a known one takes
 * eighty, and that difference enumerates the member list from the outside.
 *
 * It is also what a member with a NULL `password_hash` gets, which is anyone
 * who signed up through Google or a code. From outside, "no account" and "no
 * password set" and "wrong password" are indistinguishable, which is what
 * FP-02 section 3.4 rule 3 requires.
 */
export async function verifyAgainstNothing(password: string): Promise<false> {
  if (dummyHash === null) {
    dummyHash = await hashPassword(randomBytes(32).toString("base64"));
  }

  await verifyPassword(password, dummyHash);
  return false;
}

/**
 * Should this hash be replaced on the next successful sign-in?
 *
 * True when the algorithm tag is not the current one, or the cost parameters
 * are below the current ones. This is what makes the Argon2id upgrade a
 * one-file change: raise the parameters or add the algorithm, and members
 * migrate as they sign in.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  if (!parsed) return true;

  return parsed.algorithm !== "scrypt" || parsed.N < PARAMS.N || parsed.r < PARAMS.r;
}

// ============================================================================
// PARSING
// ============================================================================

interface ParsedHash {
  algorithm: string;
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseStored(stored: string): ParsedHash | null {
  if (typeof stored !== "string") return null;

  const parts = stored.split("$");
  if (parts.length !== 4) return null;

  const [algorithm, paramString, saltB64, hashB64] = parts as [string, string, string, string];
  if (algorithm !== "scrypt") return null;

  const params: Record<string, number> = {};
  for (const pair of paramString.split(",")) {
    const [key, value] = pair.split("=");
    if (key === undefined || value === undefined) return null;
    if (!/^\d+$/.test(value)) return null;
    params[key] = Number(value);
  }

  const N = params["N"];
  const r = params["r"];
  const p = params["p"];
  if (N === undefined || r === undefined || p === undefined) return null;

  // scrypt requires N to be a power of two greater than one. Passing a bad N
  // throws inside the KDF, and this check turns that into a clean false.
  if (N < 2 || (N & (N - 1)) !== 0) return null;

  try {
    const salt = Buffer.from(saltB64, "base64");
    const hash = Buffer.from(hashB64, "base64");
    if (salt.length === 0 || hash.length === 0) return null;

    return { algorithm, N, r, p, salt, hash };
  } catch {
    return null;
  }
}
