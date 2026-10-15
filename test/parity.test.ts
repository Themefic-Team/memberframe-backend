/**
 * Three-way parity. THE TEST THIS PACKAGE EXISTS TO MAKE POSSIBLE.
 *
 * PRD section 11.3 requires `isEntitled` to be implemented identically in the
 * plugin, the canvas components, and the backend, and says in plain words that
 * divergence between the three is a security defect.
 *
 * Until this file existed, two of the three were checked. The frontend's
 * `test/memberGateParity.test.ts` compares the plugin copy against the canvas
 * copy, and the backend copy had nothing watching it. That was the copy that
 * actually decides whether a real member gets in: the other two run in a
 * browser, where their verdict is advisory and anyone can bypass them with
 * curl. A backend that said yes where the components said no would be invisible
 * to every test in the repository and would hand out access nobody authorized.
 *
 * The same argument applies to the password policy, with the sign flipped: the
 * two browser copies are hints and this one is the rule, so a client that
 * accepts what the server refuses produces a form that passes and then a 400
 * with no field to blame.
 *
 * This test reads across the directory boundary into the frontend package.
 * That coupling is deliberate and is the cheapest honest option: a published
 * shared package for three consumers in one git repository is more machinery
 * than the problem deserves, and the canvas component cannot import from a
 * package at all, because Framer compiles it alone on a creator's site.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe as baseDescribe, expect, it } from "vitest";

/**
 * The frontend checkout. The backend now lives in its own repository, so this
 * defaults to a sibling `memberframe` folder and can be overridden with
 * FRONTEND_DIR. When no frontend is present (a deploy box, the backend's own
 * CI) the whole file is skipped with a warning rather than failing.
 */
const ROOT = path.resolve(process.env.FRONTEND_DIR ?? path.join(process.cwd(), "..", "memberframe"));
const HAS_FRONTEND = existsSync(path.join(ROOT, "src", "utils", "entitlement.ts"));
if (!HAS_FRONTEND) {
  console.warn(`[parity] Frontend not found at ${ROOT}; skipping parity checks. Set FRONTEND_DIR to run them.`);
}
const describe = HAS_FRONTEND ? baseDescribe : baseDescribe.skip;

const SOURCES = {
  plugin: {
    entitlement: path.join(ROOT, "src", "utils", "entitlement.ts"),
    credentials: path.join(ROOT, "src", "utils", "credentials.ts"),
  },
  canvas: {
    gate: path.join(ROOT, "src", "canvas-components", "MemberGate.tsx"),
    auth: path.join(ROOT, "src", "canvas-components", "MemberAuth.tsx"),
  },
  backend: {
    entitlement: path.join(process.cwd(), "src", "lib", "entitlement.ts"),
    credentials: path.join(process.cwd(), "src", "lib", "credentials.ts"),
  },
} as const;

function read(file: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch (error) {
    throw new Error(
      `Could not read ${file}. This test runs from the backend package and reads the frontend's source, so it needs the whole repository, not just this folder. (${String(error)})`
    );
  }
}

/**
 * Pull one function out by name, by counting braces.
 *
 * A regex cannot do this: the body contains braces and a greedy or lazy match
 * stops at the wrong one. Same extractor as the frontend's parity tests, and
 * duplicated rather than imported because importing it would mean this package
 * depends on the frontend's test tree.
 */
function extractFunction(source: string, name: string): string {
  const signature = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!signature) throw new Error(`No function named ${name} in the source.`);

  const open = source.indexOf("{", signature.index);
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(signature.index, index + 1);
  }

  throw new Error(`Unbalanced braces while extracting ${name}.`);
}

function extractConstant(source: string, name: string): string {
  // `[^=]*` skips a type annotation, as in `const X: ReadonlyArray<T> = [...]`.
  // Without it this matched only a bare `const X = 8;` and threw on everything
  // else, which is exactly how it first failed on DEFAULT_SITE_TIERS.
  const match = new RegExp(`${name}[^=]*=\\s*([^;]+);`).exec(source);
  if (!match) throw new Error(`No constant named ${name} in the source.`);
  return (match[1] ?? "").trim();
}

function extractArrayEntries(source: string, name: string): string[] {
  const start = new RegExp(`${name}[^=]*=\\s*\\[`).exec(source);
  if (!start) throw new Error(`No array named ${name} in the source.`);

  const open = source.indexOf("[", start.index);
  const close = source.indexOf("]", open);
  if (close === -1) throw new Error(`Unterminated array ${name}.`);

  return source
    .slice(open + 1, close)
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry !== "");
}

/** Comments and whitespace may differ. Each copy explains itself differently. */
function normalize(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// isEntitled, ALL THREE COPIES
// ============================================================================

describe("isEntitled is identical in all three copies", () => {
  const plugin = normalize(extractFunction(read(SOURCES.plugin.entitlement), "isEntitled"));
  const canvas = normalize(extractFunction(read(SOURCES.canvas.gate), "isEntitled"));
  const backend = normalize(extractFunction(read(SOURCES.backend.entitlement), "isEntitled"));

  it("the backend copy matches the plugin copy", () => {
    expect(backend).toBe(plugin);
  });

  it("the backend copy matches the canvas copy", () => {
    expect(backend).toBe(canvas);
  });

  it("the extraction found a real function, not an empty string", () => {
    // Without this, deleting the function from all three would pass every
    // assertion above by making them all equal to "".
    expect(backend.length).toBeGreaterThan(200);
    expect(backend).toContain("held.rank >= required.rank");
  });

  it("the fallback ladder ranks the same keys the same way", () => {
    // Compared as DATA, not as source text, and that distinction is the point.
    //
    // Section 11.3 requires the RESOLVER to be identical. The ladder it reads
    // is not part of that rule: the backend loads real tiers from MySQL and
    // this fallback is only what either side uses before the site has any.
    // The declarations legitimately differ too, because the frontend narrows
    // `key` to the four known literals while the backend keeps `string`, since
    // a creator can define their own keys. That is conflict C9, not a defect.
    //
    // What WOULD be a defect is the two fallbacks disagreeing about order, so
    // that a VIP outranks Gold in one and not the other. That is what this
    // checks.
    const pairs = (source: string): string =>
      (extractConstant(source, "DEFAULT_SITE_TIERS").match(/key:\s*"[^"]+",\s*rank:\s*\d+/g) ?? [])
        .map((entry) => entry.replace(/\s+/g, " "))
        .join(" | ");

    const frontend = pairs(read(path.join(ROOT, "src", "types", "member.ts")));
    const backend = pairs(read(SOURCES.backend.entitlement));

    expect(frontend).not.toBe("");
    expect(backend).toBe(frontend);
  });
});

describe("the parity check can fail", () => {
  // The only reason to trust a comparison is having watched it reject
  // something. Each of these is a plausible edit rather than a contrived one.

  it("rejects a flipped comparison operator", () => {
    const real = normalize(extractFunction(read(SOURCES.backend.entitlement), "isEntitled"));
    const perturbed = real.replace("held.rank >= required.rank", "held.rank > required.rank");

    expect(perturbed).not.toBe(real);
    // That single character is the difference between a VIP passing a VIP gate
    // and being refused by it.
  });

  it("rejects a dropped status", () => {
    const real = normalize(extractFunction(read(SOURCES.backend.entitlement), "isEntitled"));
    const perturbed = real.replace('session.status === "trialing" ||', "");

    expect(perturbed).not.toBe(real);
  });

  it("throws rather than returning a truncated body on unbalanced braces", () => {
    expect(() => extractFunction("function broken() { if (true) {", "broken")).toThrow(
      /Unbalanced braces/
    );
  });

  it("throws on a function that is not there", () => {
    expect(() => extractFunction("const x = 1;", "isEntitled")).toThrow(/No function named/);
  });
});

// ============================================================================
// THE PASSWORD POLICY, ALL THREE COPIES
// ============================================================================

const SHARED_FUNCTIONS = ["looksLikeEmail", "passwordProblems", "passwordScore"] as const;

const SHARED_CONSTANTS = [
  "PASSWORD_MIN_LENGTH",
  "PASSWORD_MAX_LENGTH",
  "EMAIL_FRAGMENT_MIN_LENGTH",
] as const;

describe("the password policy is identical in all three copies", () => {
  const pluginSource = read(SOURCES.plugin.credentials);
  const canvasSource = read(SOURCES.canvas.auth);
  const backendSource = read(SOURCES.backend.credentials);

  for (const name of SHARED_FUNCTIONS) {
    it(`${name} matches across plugin, canvas, and backend`, () => {
      const plugin = normalize(extractFunction(pluginSource, name));
      const canvas = normalize(extractFunction(canvasSource, name));
      const backend = normalize(extractFunction(backendSource, name));

      expect(backend).toBe(plugin);
      expect(backend).toBe(canvas);
    });
  }

  for (const name of SHARED_CONSTANTS) {
    it(`${name} matches across all three`, () => {
      // A matching function body with a different number would pass the checks
      // above and still disagree with the other copies at runtime.
      expect(extractConstant(backendSource, name)).toBe(extractConstant(pluginSource, name));
      expect(extractConstant(backendSource, name)).toBe(extractConstant(canvasSource, name));
    });
  }

  it("the common-password list matches entry for entry, in order", () => {
    const backend = extractArrayEntries(backendSource, "COMMON_PASSWORDS");

    expect(backend).toEqual(extractArrayEntries(pluginSource, "COMMON_PASSWORDS"));
    expect(backend).toEqual(extractArrayEntries(canvasSource, "COMMON_PASSWORDS"));
    expect(backend.length).toBeGreaterThan(5);
  });
});

// ============================================================================
// THE INVERSION THAT MAKES THIS COPY DIFFERENT
// ============================================================================

describe("the server copy is the rule, not the hint", () => {
  const backendSource = read(SOURCES.backend.credentials);

  it("does not let a caller turn strength checking off", () => {
    // `requirePasswordStrength` is a creator-facing property control on the
    // component, where it decides what the sign-up form nags about. A creator
    // unticking it is not choosing to let a one-character password into the
    // database, so the server's own entry point hard-codes true.
    expect(backendSource).toContain("passwordProblems(password, email, true)");
  });

  it("exposes an entry point that takes no strength flag at all", () => {
    expect(backendSource).toMatch(
      /export function isAcceptablePassword\(\s*password: string,\s*email: string\s*\)/
    );
  });
});
