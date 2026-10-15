/**
 * Password hashing.
 *
 * The properties here are the ones that matter if they break silently, and
 * every one of them has a plausible way to break while still looking correct:
 * a hash that always verifies, a salt that is reused, a comparison that returns
 * early, a parser that throws on a corrupt row and turns a sign-in into a 500.
 */

import { describe, expect, it } from "vitest";
import {
  hashPassword,
  needsRehash,
  verifyAgainstNothing,
  verifyPassword,
} from "../src/lib/password.js";

describe("hashPassword", () => {
  it("produces the documented self-describing format", () => {
    // The algorithm tag is what makes the Argon2id upgrade a one-file change:
    // `verify` dispatches on it, so old and new hashes can coexist and members
    // migrate as they sign in.
    return hashPassword("correct horse battery").then((stored) => {
      const parts = stored.split("$");

      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe("scrypt");
      expect(parts[1]).toMatch(/^N=\d+,r=\d+,p=\d+$/);
      expect(parts[2]!.length).toBeGreaterThan(0);
      expect(parts[3]!.length).toBeGreaterThan(0);
    });
  });

  it("never produces the same hash twice for the same password", async () => {
    // A reused salt means identical passwords produce identical hashes, which
    // tells anyone with a database dump which members share a password.
    const [a, b] = await Promise.all([hashPassword("same-password-1"), hashPassword("same-password-1")]);

    expect(a).not.toBe(b);
  });

  it("stores neither the password nor anything resembling it", async () => {
    const stored = await hashPassword("hunter2-is-the-password");

    expect(stored).not.toContain("hunter2");
    expect(stored.toLowerCase()).not.toContain("password");
  });

  it("handles a password with characters that break naive encoding", async () => {
    // The stored format is `$` separated, so a password containing `$` is the
    // obvious way to corrupt it. It cannot: the password is hashed, never
    // embedded.
    const awkward = 'p$a$s$s"word\\with\nnewline\tand\ttabs';
    const stored = await hashPassword(awkward);

    expect(stored.split("$")).toHaveLength(4);
    await expect(verifyPassword(awkward, stored)).resolves.toBe(true);
  });

  it("handles a long passphrase without truncating it", async () => {
    // Conflict C15: bcrypt silently truncates at 72 bytes, so two different
    // long passwords would unlock one account. scrypt has no such ceiling, and
    // this is the test that would catch a swap back to bcrypt.
    const base = "a".repeat(100);
    const stored = await hashPassword(`${base}FIRST`);

    await expect(verifyPassword(`${base}FIRST`, stored)).resolves.toBe(true);
    await expect(verifyPassword(`${base}SECOND`, stored)).resolves.toBe(false);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password", async () => {
    const stored = await hashPassword("Tr0ubadour-sprocket");
    await expect(verifyPassword("Tr0ubadour-sprocket", stored)).resolves.toBe(true);
  });

  it("rejects the wrong one", async () => {
    const stored = await hashPassword("Tr0ubadour-sprocket");
    await expect(verifyPassword("Tr0ubadour-sprockeT", stored)).resolves.toBe(false);
  });

  it("rejects an empty password against a real hash", async () => {
    const stored = await hashPassword("Tr0ubadour-sprocket");
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("returns false rather than throwing on a corrupt stored value", async () => {
    // This is the important one. A row with a mangled hash must fail closed:
    // throwing would surface as a 500, and a 500 on sign-in for one specific
    // address tells an attacker that address is interesting.
    const corrupt = [
      "",
      "not-a-hash",
      "scrypt$",
      "scrypt$N=16384,r=8,p=1",
      "scrypt$N=16384,r=8,p=1$only-three-parts",
      "scrypt$N=abc,r=8,p=1$c2FsdA==$aGFzaA==",
      "scrypt$N=0,r=8,p=1$c2FsdA==$aGFzaA==",
      "scrypt$N=12345,r=8,p=1$c2FsdA==$aGFzaA==", // N not a power of two
      "argon2id$m=65536$c2FsdA==$aGFzaA==",
      "$$$",
    ];

    for (const stored of corrupt) {
      await expect(verifyPassword("anything", stored)).resolves.toBe(false);
    }
  });

  it("survives a stored value that is not a string at all", async () => {
    // A JSON column, a null from a migration, a number. The signature says
    // string and the database does not care.
    await expect(
      verifyPassword("anything", null as unknown as string)
    ).resolves.toBe(false);
    await expect(verifyPassword("anything", 42 as unknown as string)).resolves.toBe(false);
  });
});

describe("verifyAgainstNothing", () => {
  it("always returns false", async () => {
    await expect(verifyAgainstNothing("anything")).resolves.toBe(false);
    await expect(verifyAgainstNothing("")).resolves.toBe(false);
  });

  it("spends comparable time to a real verification", async () => {
    // The whole defence against a timing oracle on sign-in. Without it an
    // unknown address answers in under a millisecond while a real one takes
    // tens, and that difference enumerates the member list from outside.
    //
    // Timing in a test is inherently noisy, so this asserts a loose bound: the
    // dummy path must be the same order of magnitude, not the same number.
    // What it catches is the regression that matters, which is someone
    // removing the call and making the unknown-address path return instantly.
    const stored = await hashPassword("a-real-password-here");

    const realStart = performance.now();
    await verifyPassword("a-real-password-here", stored);
    const realMs = performance.now() - realStart;

    const dummyStart = performance.now();
    await verifyAgainstNothing("a-real-password-here");
    const dummyMs = performance.now() - dummyStart;

    expect(dummyMs).toBeGreaterThan(realMs * 0.2);
  });
});

describe("needsRehash", () => {
  it("is false for a hash at the current parameters", async () => {
    expect(needsRehash(await hashPassword("whatever-123"))).toBe(false);
  });

  it("is true for weaker parameters", () => {
    expect(needsRehash("scrypt$N=1024,r=8,p=1$c2FsdA==$aGFzaA==")).toBe(true);
  });

  it("is true for another algorithm, which is how the Argon2id upgrade lands", () => {
    expect(needsRehash("argon2id$m=65536,t=4,p=1$c2FsdA==$aGFzaA==")).toBe(true);
  });

  it("is true for anything unparseable, so a corrupt row gets replaced", () => {
    expect(needsRehash("")).toBe(true);
    expect(needsRehash("nonsense")).toBe(true);
  });
});
