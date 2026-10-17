/**
 * Sign in provider secrets leave the settings document and are sealed.
 *
 * What the panel is sent, and what the settings row stores, must never carry
 * a client secret again; the OAuth routes must still find it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env["PAYMENTS_ENCRYPTION_KEY"] = Buffer.alloc(32, 9).toString("base64");

const store = new Map<string, string>();
vi.mock("../src/config/db.js", () => ({
  prisma: {
    integrationSecret: {
      findUnique: vi.fn(async ({ where }: { where: { siteId_integrationId: { siteId: string; integrationId: string } } }) => {
        const key = `${where.siteId_integrationId.siteId}:${where.siteId_integrationId.integrationId}`;
        return store.has(key) ? { secretsEncrypted: store.get(key) } : null;
      }),
      upsert: vi.fn(async ({ where, create }: { where: { siteId_integrationId: { siteId: string; integrationId: string } }; create: { secretsEncrypted: string } }) => {
        store.set(`${where.siteId_integrationId.siteId}:${where.siteId_integrationId.integrationId}`, create.secretsEncrypted);
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));
vi.mock("../src/services/settingsService.js", () => ({ invalidateSiteSettings: vi.fn() }));

const { readIntegrationSecret, storePatchSecrets, takePatchSecrets, withoutSecrets } = await import(
  "../src/services/integrationSecrets.js"
);
const { mergeSettings, withDefaults } = await import("../src/lib/siteSettings.js");

beforeEach(() => store.clear());

describe("provider secrets", () => {
  it("takes the secret out of the patch, seals it, and records only that one is stored", async () => {
    const patch = { integrations: { google_oauth: { enabled: true, values: { clientId: "id-1", clientSecret: "shh" } } } };
    const taken = takePatchSecrets(patch);
    expect(patch.integrations.google_oauth.values).toEqual({ clientId: "id-1" });

    const merged = mergeSettings(withDefaults({}), patch);
    await storePatchSecrets("site_1", taken, merged);

    expect(merged.integrations["google_oauth"]?.values).toEqual({ clientId: "id-1" });
    expect(merged.integrations["google_oauth"]?.secretsPresent).toEqual(["clientSecret"]);
    expect([...store.values()][0]).not.toContain("shh");
    expect(await readIntegrationSecret("site_1", "google_oauth", "clientSecret")).toBe("shh");
  });

  it("keeps the stored secret when a later save leaves it empty", async () => {
    await storePatchSecrets("site_1", { github_oauth: { clientSecret: "first" } }, withDefaults({}));
    const patch = { integrations: { github_oauth: { enabled: true, values: { clientId: "id-2", clientSecret: "" } } } };
    const merged = mergeSettings(withDefaults({}), patch);
    await storePatchSecrets("site_1", takePatchSecrets(patch), merged);
    expect(await readIntegrationSecret("site_1", "github_oauth", "clientSecret")).toBe("first");
  });

  it("moves a plain text secret from an old document into the store", async () => {
    const legacy = withDefaults({ integrations: { discord_oauth: { enabled: true, values: { clientId: "d", clientSecret: "old" } } } });
    await storePatchSecrets("site_1", {}, legacy);
    expect(legacy.integrations["discord_oauth"]?.values["clientSecret"]).toBeUndefined();
    expect(await readIntegrationSecret("site_1", "discord_oauth", "clientSecret")).toBe("old");
  });

  it("never sends a secret to the panel, even from a document not yet migrated", () => {
    const legacy = withDefaults({ integrations: { apple_oauth: { enabled: true, values: { clientId: "a", clientSecret: "plain" } } } });
    const safe = withoutSecrets(legacy);
    expect(JSON.stringify(safe)).not.toContain("plain");
    expect(safe.integrations["apple_oauth"]?.secretsPresent).toContain("clientSecret");
  });
});
