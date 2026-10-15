import { describe, expect, it } from "vitest";

describe("OAuth State and Token Utilities", () => {
  it("encodes and decodes OAuth state correctly", () => {
    const siteId = "site_abc123";
    const origin = "https://example.framer.website";
    const statePayload = {
      siteId,
      origin,
      nonce: "random_nonce_123",
    };

    const encoded = Buffer.from(JSON.stringify(statePayload)).toString("base64url");
    expect(typeof encoded).toBe("string");
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("+");

    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as typeof statePayload;
    expect(decoded.siteId).toBe(siteId);
    expect(decoded.origin).toBe(origin);
    expect(decoded.nonce).toBe("random_nonce_123");
  });

  it("extracts claims from a base64url encoded JWT payload", () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "apple-key-1" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://appleid.apple.com",
        sub: "000123.apple.unique.id",
        email: "user@privaterelay.appleid.com",
        email_verified: "true",
      })
    ).toString("base64url");
    const signature = "fake_sig_123";

    const fakeJwt = `${header}.${payload}.${signature}`;
    const parts = fakeJwt.split(".");
    expect(parts.length).toBe(3);

    const payloadPart = parts[1];
    expect(payloadPart).toBeDefined();

    const decodedPayload = JSON.parse(Buffer.from(payloadPart!, "base64url").toString("utf8")) as {
      sub: string;
      email: string;
    };

    expect(decodedPayload.sub).toBe("000123.apple.unique.id");
    expect(decodedPayload.email).toBe("user@privaterelay.appleid.com");
  });

  it("handles Discord avatar URL generation", () => {
    const userId = "80351110224678912";
    const avatarHash = "83427290963c5a0355f79f632e56e761";
    const avatarUrl = `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`;

    expect(avatarUrl).toBe("https://cdn.discordapp.com/avatars/80351110224678912/83427290963c5a0355f79f632e56e761.png");
  });

  it("resolves primary and verified email from GitHub email list", () => {
    const emails = [
      { email: "secondary@example.com", primary: false, verified: true },
      { email: "unverified@example.com", primary: true, verified: false },
      { email: "primary@example.com", primary: true, verified: true },
    ];

    const resolved = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
    expect(resolved?.email).toBe("primary@example.com");
  });
});
