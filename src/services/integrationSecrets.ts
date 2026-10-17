/**
 * Sign in provider secrets, encrypted at rest.
 *
 * The client secrets for Google, GitHub, Apple, and Discord used to sit in
 * plain text inside the settings document, which is also sent back to the
 * plugin panel on every read. Now:
 *
 *   - saving takes each secret out of the incoming values and seals it into
 *     `integration_secrets` with the same AES-256-GCM box as gateway keys
 *   - the document keeps the non-secret values and `secretsPresent`, which is
 *     all the panel needs to say "Saved. Type to replace it."
 *   - an omitted or empty secret on a later save keeps the stored one, so a
 *     creator editing a client id does not have to paste the secret again
 *   - the OAuth routes read secrets through `readIntegrationSecret`
 *   - plain text secrets from before this change are moved at startup by
 *     `migratePlaintextIntegrationSecrets`
 *
 * Without PAYMENTS_ENCRYPTION_KEY there is nowhere safe to put a secret, so
 * the old behaviour stays (the value stays in the document) rather than
 * breaking sign in on a development machine. Production refuses to start
 * without the key (`config/env.ts`).
 */

import { prisma } from "../config/db.js";
import { openJson, sealJson, secretsAvailable } from "../lib/secretBox.js";
import { invalidateSiteSettings } from "./settingsService.js";
import { toJsonDocument, withDefaults, type SiteSettingsDocument } from "../lib/siteSettings.js";

/** Which value of each integration is a secret. Must match `secret: true` in the plugin's registry. */
export const SECRET_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  google_oauth: ["clientSecret"],
  github_oauth: ["clientSecret"],
  apple_oauth: ["clientSecret"],
  discord_oauth: ["clientSecret"],
};

async function readStore(siteId: string, integrationId: string): Promise<Record<string, string>> {
  const row = await prisma.integrationSecret.findUnique({
    where: { siteId_integrationId: { siteId, integrationId } },
  });
  return row ? openJson(row.secretsEncrypted) : {};
}

async function writeStore(siteId: string, integrationId: string, secrets: Record<string, string>): Promise<void> {
  if (Object.keys(secrets).length === 0) {
    await prisma.integrationSecret.deleteMany({ where: { siteId, integrationId } });
    return;
  }
  const secretsEncrypted = sealJson(secrets);
  await prisma.integrationSecret.upsert({
    where: { siteId_integrationId: { siteId, integrationId } },
    create: { siteId, integrationId, secretsEncrypted },
    update: { secretsEncrypted },
  });
}

/**
 * Take the secrets out of a settings patch, before it is merged.
 *
 * Returns what was taken, per integration, so `storePatchSecrets` can seal it
 * once the save is known to be valid. Mutates the patch: after this, nothing
 * secret is left in it to be written into the document.
 */
export function takePatchSecrets(patch: unknown): Record<string, Record<string, string>> {
  const taken: Record<string, Record<string, string>> = {};
  if (!secretsAvailable() || !patch || typeof patch !== "object") return taken;

  const integrations = (patch as Record<string, unknown>)["integrations"];
  if (!integrations || typeof integrations !== "object") return taken;

  for (const [id, entry] of Object.entries(integrations as Record<string, unknown>)) {
    const fields = SECRET_FIELDS[id];
    if (!fields || !entry || typeof entry !== "object") continue;
    const values = (entry as Record<string, unknown>)["values"];
    if (!values || typeof values !== "object") continue;

    for (const field of fields) {
      const value = (values as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim() !== "") {
        (taken[id] ??= {})[field] = value.trim();
      }
      delete (values as Record<string, unknown>)[field];
    }
  }
  return taken;
}

/**
 * Seal what `takePatchSecrets` took, merged over what is already stored, and
 * record which secrets each integration now holds in the merged document.
 * Also clears any plain text secret still in the document from before.
 */
export async function storePatchSecrets(
  siteId: string,
  taken: Record<string, Record<string, string>>,
  document: SiteSettingsDocument
): Promise<void> {
  if (!secretsAvailable()) return;

  for (const [id, fields] of Object.entries(SECRET_FIELDS)) {
    const entry = document.integrations[id];
    const legacy: Record<string, string> = {};
    if (entry) {
      for (const field of fields) {
        const plain = entry.values[field];
        if (typeof plain === "string" && plain !== "") legacy[field] = plain;
        delete entry.values[field];
      }
    }

    const incoming = taken[id];
    if (!incoming && Object.keys(legacy).length === 0) {
      if (entry) entry.secretsPresent = Object.keys(await readStore(siteId, id));
      continue;
    }

    const stored = await readStore(siteId, id);
    const next = { ...stored, ...legacy, ...(incoming ?? {}) };
    await writeStore(siteId, id, next);
    if (entry) entry.secretsPresent = Object.keys(next);
  }
}

/**
 * One secret, for an OAuth exchange. The encrypted store first; the plain
 * document value only for a site saved before encryption existed, and only
 * until the startup migration has run.
 */
export async function readIntegrationSecret(
  siteId: string,
  integrationId: string,
  field: string,
  legacyValues?: Record<string, string>
): Promise<string> {
  if (secretsAvailable()) {
    const stored = await readStore(siteId, integrationId);
    if (stored[field]) return stored[field];
  }
  return legacyValues?.[field] ?? "";
}

/** A copy of the document safe to send to the panel: no secret value anywhere. */
export function withoutSecrets(document: SiteSettingsDocument): SiteSettingsDocument {
  const integrations: SiteSettingsDocument["integrations"] = {};
  for (const [id, entry] of Object.entries(document.integrations)) {
    const values = { ...entry.values };
    for (const field of SECRET_FIELDS[id] ?? []) {
      if (values[field]) {
        delete values[field];
      }
    }
    const present = new Set(entry.secretsPresent);
    for (const field of SECRET_FIELDS[id] ?? []) {
      if (entry.values[field]) present.add(field);
    }
    integrations[id] = { enabled: entry.enabled, values, secretsPresent: [...present] };
  }
  return { ...document, integrations };
}

/**
 * Move every plain text provider secret into the encrypted store. Run once at
 * startup; a no-op once nothing is left to move.
 */
export async function migratePlaintextIntegrationSecrets(): Promise<number> {
  if (!secretsAvailable()) return 0;

  const rows = await prisma.siteSettings.findMany({ select: { siteId: true, settings: true } });
  let moved = 0;

  for (const row of rows) {
    const document = withDefaults(row.settings);
    const hasPlain = Object.entries(SECRET_FIELDS).some(([id, fields]) =>
      fields.some((field) => Boolean(document.integrations[id]?.values[field]))
    );
    if (!hasPlain) continue;

    await storePatchSecrets(row.siteId, {}, document);
    await prisma.siteSettings.update({
      where: { siteId: row.siteId },
      data: { settings: toJsonDocument(document) },
    });
    invalidateSiteSettings(row.siteId);
    moved += 1;
  }
  return moved;
}
