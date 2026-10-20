/**
 * 31-sign-in-methods.md 4: the sign-in callbacks trust only what they can
 * check. Apple's token comes from Apple's endpoint, never from the posted
 * form; GitHub and Discord refuse an address they have not verified.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {} }));

const { appleIdClaims } = await import("../src/routes/member.js");
const source = readFileSync(join(__dirname, "..", "src", "routes", "member.ts"), "utf8");

const token = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const NOW = 1_800_000_000_000;
const good = { iss: "https://appleid.apple.com", aud: "com.site.web", exp: NOW / 1000 + 600, sub: "apple-sub", email: "ada@example.com", email_verified: "true" };

describe("appleIdClaims", () => {
  it("accepts Apple's token for this client, with its subject and verified email", () => {
    expect(appleIdClaims(token(good), "com.site.web", NOW)).toEqual({ sub: "apple-sub", email: "ada@example.com", emailVerified: true });
  });

  it("refuses another issuer, another client, an expired token, or no subject", () => {
    expect(appleIdClaims(token({ ...good, iss: "https://evil.example" }), "com.site.web", NOW)).toBeNull();
    expect(appleIdClaims(token({ ...good, aud: "com.other.app" }), "com.site.web", NOW)).toBeNull();
    expect(appleIdClaims(token({ ...good, exp: NOW / 1000 - 1 }), "com.site.web", NOW)).toBeNull();
    expect(appleIdClaims(token({ ...good, sub: "" }), "com.site.web", NOW)).toBeNull();
  });
});

describe("the callbacks", () => {
  it("never read an id_token posted to Apple's callback", () => {
    expect(source).not.toContain('req.body["id_token"]');
    expect(source).toContain("const claims = tokenJson.id_token ? appleIdClaims(tokenJson.id_token, clientId) : null;");
  });

  it("take the site only from a signed state", () => {
    expect(source).not.toContain("stateObj.siteId || req.site?.id");
    expect(source).toContain("return verifyOAuthState(stateParam) ?? {};");
  });

  it("refuse an unverified GitHub or Discord address", () => {
    expect(source).toContain('const verified = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);');
    expect(source).not.toContain("|| emails[0]");
    expect(source).toContain('reason: "github_email_unverified",');
    expect(source).toContain("if (user.verified !== true) {");
  });
});

describe("sign in answers carry the site's After sign in page", () => {
  it("on password, code, reset, social exchange, and session", () => {
    expect(source.match(/afterLoginPath: await afterLoginPathOf\(site\.id\)/g)?.length).toBe(5);
    expect(source).toContain('return path === "" || isSafeSitePath(path) ? path : "/dashboard";');
  });
});
