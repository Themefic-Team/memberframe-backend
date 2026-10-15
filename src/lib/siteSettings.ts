/**
 * The site settings document.
 *
 * Everything a creator configures about one site lives in a single JSON column
 * keyed by site id, rather than a column per switch. That was an explicit
 * instruction and it is the right call for this product: settings arrive
 * continuously, and the alternative is an `ALTER TABLE` per toggle on a table
 * that holds a row per paying customer.
 *
 * ## The price, paid here
 *
 * A JSON column means the database validates nothing. There is no `NOT NULL` on
 * `auth.loginPath`, no `CHECK` on `auth.defaultMethod`, and nothing stops a row
 * from holding `{"auth": 7}`. So this module is the only thing that writes one,
 * and it does three jobs no column would have needed:
 *
 *   1. **Defaults on read.** `readSettings` never returns a partial document.
 *      A row written before a field existed reads back with that field at its
 *      default, so no consumer has to write `settings.auth?.loginPath ?? "/"`.
 *   2. **Validation on write.** `validatePatch` rejects a wrong type rather
 *      than storing it, because a bad value in a JSON column surfaces as a
 *      runtime error on a published site, far from whoever wrote it.
 *   3. **Merge, not replace.** A panel that knows about four settings must not
 *      erase a fifth it has never heard of. `mergeSettings` is per key, which
 *      makes a plugin that is a version behind safe rather than destructive.
 *
 * ## What must never be in here
 *
 * A secret. This document is returned to the plugin panel whole, so a gateway
 * key placed here would be handed to any creator session that asks. Keys are
 * encrypted in their own table, backend PRD phase B3. `stripSecrets` is a last
 * line of defence, not permission to try.
 */

import type { Prisma } from "@prisma/client";

// ============================================================================
// THE SHAPE
// ============================================================================

/**
 * Bumped when a field changes meaning, not when one is added.
 *
 * Adding a field needs no bump: `withDefaults` fills it. A bump is for the case
 * `withDefaults` cannot handle, where an existing field must be reinterpreted,
 * and `upgrade` below is where that reinterpretation goes.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Which email method `<MemberAuth>` opens on. Mirrors `AuthMethod` in the plugin. */
export type AuthMethodSetting = "password" | "otp";

/**
 * The paths on the creator's own Framer site.
 *
 * Paths, not URLs. The site's own origin is already known from the allowlist,
 * and storing a full URL invites a creator to paste someone else's: every one
 * of these ends up in a redirect, and an open redirect is how a sign-in page
 * becomes a phishing hop.
 */
export interface AuthSettings {
  /** Where `<MemberGate>` sends a signed-out visitor. FP-02, and the first thing a creator configures. */
  loginPath: string;
  /** Where the sign-up view lives, when the creator split it from sign-in. */
  signupPath: string;
  /** The page carrying `<MemberAuth>` in reset mode. The emailed link points here. */
  resetPath: string;
  /** Where a visitor lands after signing in. */
  afterLoginPath: string;
  /** Where a visitor lands after signing out. */
  afterLogoutPath: string;
  /** Whether `/api/member/register` accepts new members at all. */
  allowRegistration: boolean;
  /** Which view `<MemberAuth>` opens on. */
  defaultMethod: AuthMethodSetting;
  /** Whether the password policy asks for a letter and a digit. */
  requirePasswordStrength: boolean;
  /** Days a "remember me" session lasts. */
  rememberMeDays: number;
}

/** Creator-facing identity, used in the emails this site sends. */
export interface BrandingSettings {
  /** Appears in the subject line of every email to a member of this site. */
  displayName: string;
  supportEmail: string;
}

/**
 * What the Builder tab last deployed.
 *
 * Here rather than in its own table because nothing queries it: it exists so
 * the panel can say "deployed 3 minutes ago" and so a creator can tell whether
 * the component on the canvas predates a settings change.
 */
export interface CanvasSettings {
  lastDeployedAt: string | null;
  deployedComponents: string[];
}

/**
 * The field types a creator may define. FP-09 section 2.
 *
 * A closed union, not an open string. The member-facing form renders a
 * different control per type and the validator applies a different rule, so an
 * unrecognised type has no behaviour at all: it would render nothing and
 * validate nothing, which is worse than being refused at definition time.
 */
export type CustomFieldType =
  | "text"
  | "textarea"
  | "url"
  | "phone"
  | "select"
  | "boolean"
  | "number";

export const CUSTOM_FIELD_TYPES: ReadonlyArray<CustomFieldType> = [
  "text",
  "textarea",
  "url",
  "phone",
  "select",
  "boolean",
  "number",
];

/**
 * One creator-defined member attribute. FP-09 section 4.1.
 *
 * Defined HERE, in the settings document, rather than in a `custom_fields`
 * table, and that follows directly from the decision to keep settings as one
 * JSON column. The definitions are configuration: a handful per site, read
 * whole, written whole, never queried across sites. The member VALUES are not
 * configuration, and those live in `Member.metadata`, which is its own JSON
 * column on its own row.
 *
 * The alternative, a column per creator-defined field, would make a creator
 * typing a field name into a form cause an `ALTER TABLE`. That is the shape of
 * problem this product should never have.
 */
export interface CustomFieldDefinition {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  /** Only meaningful for `select`. */
  options: string[];
  placeholder: string;
  order: number;
}

/**
 * One integration's stored configuration, non-secret half only.
 *
 * The split this type exists to enforce: `values` is returned to the panel and
 * therefore may hold only what is safe to show, while `secretsPresent` names
 * the fields an encrypted store holds a value for without carrying any of them.
 *
 * PRD section 8 F03: "a secret key is never present in any client-side response
 * payload". That table, `gateway_configs` with AES-256-GCM, is backend PRD
 * phase B3 and is not built, so `secretsPresent` is empty everywhere today and
 * the panel disables every secret field with the reason on screen.
 */
export interface StoredIntegration {
  enabled: boolean;
  values: Record<string, string>;
  secretsPresent: string[];
}

export type GatedPageFallbackAction = "redirect" | "blur" | "custom_card";
export type GatedPageTier = "signed_in" | "free_member" | "tier_1" | "tier_2" | "vip";

export interface GatedPageRule {
  path: string;
  enabled: boolean;
  requiredTier: GatedPageTier;
  fallbackAction: GatedPageFallbackAction;
  redirectPath?: string;
}

export const DEFAULT_GATED_PAGES: GatedPageRule[] = [
  {
    path: "/dashboard",
    enabled: true,
    requiredTier: "signed_in",
    fallbackAction: "redirect",
    redirectPath: "/login",
  },
  {
    path: "/private-content",
    enabled: true,
    requiredTier: "signed_in",
    fallbackAction: "redirect",
    redirectPath: "/login",
  },
];

export interface SiteSettingsDocument {
  version: number;
  auth: AuthSettings;
  branding: BrandingSettings;
  canvas: CanvasSettings;
  /** Keyed by integration id. */
  integrations: Record<string, StoredIntegration>;
  /** FP-09. Ordered by `order`, and the order is what the form renders in. */
  customFields: CustomFieldDefinition[];
  gatedPages: GatedPageRule[];
}

/** At most this many per site. A form longer than this is a survey, not a profile. */
export const MAX_CUSTOM_FIELDS = 20;

/** At most this many options on one select. */
export const MAX_FIELD_OPTIONS = 50;

/**
 * A field key, as stored in `Member.metadata`.
 *
 * Restricted to lowercase, digits, and underscore, which is narrower than JSON
 * allows and deliberately so. The key becomes an object key in a JSON column
 * and a form field name, and permitting a dot or a bracket would let a creator
 * define a key that reads like a path into something else.
 *
 * `__proto__` and friends are refused outright: they are valid under the
 * pattern and are the one input that could reach an object's prototype.
 */
const RESERVED_KEYS: ReadonlyArray<string> = ["__proto__", "constructor", "prototype"];

export function isValidFieldKey(value: string): boolean {
  if (!/^[a-z][a-z0-9_]{0,48}$/.test(value)) return false;
  return !RESERVED_KEYS.includes(value);
}

// ============================================================================
// DEFAULTS
// ============================================================================

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  loginPath: "/login",
  signupPath: "/login",
  resetPath: "/reset-password",
  afterLoginPath: "/",
  afterLogoutPath: "/",
  allowRegistration: true,
  // `password`, not `otp`, and deliberately. The backend answers 501 for OTP
  // today (conflict C24), so defaulting to the code path would put a dead end
  // in front of every new site. This is the value a creator gets before they
  // touch anything, so it points at the path that works.
  defaultMethod: "password",
  requirePasswordStrength: true,
  rememberMeDays: 30,
};

export const DEFAULT_BRANDING_SETTINGS: BrandingSettings = {
  displayName: "",
  supportEmail: "",
};

export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = {
  lastDeployedAt: null,
  deployedComponents: [],
};

export function defaultSettings(): SiteSettingsDocument {
  return {
    version: SETTINGS_SCHEMA_VERSION,
    auth: { ...DEFAULT_AUTH_SETTINGS },
    branding: { ...DEFAULT_BRANDING_SETTINGS },
    canvas: { ...DEFAULT_CANVAS_SETTINGS, deployedComponents: [] },
    customFields: [],
    integrations: {},
    gatedPages: [...DEFAULT_GATED_PAGES],
  };
}

/**
 * An integration id, as stored.
 *
 * Narrow on purpose. The id becomes an object key in a JSON column, and
 * permitting a dot, a bracket, or a prototype name would let a caller define a
 * key that reads like a path into something else. The same rule and the same
 * reasoning as `isValidFieldKey`.
 */
export function isValidIntegrationId(value: string): boolean {
  if (!/^[a-z][a-z0-9_]{0,48}$/.test(value)) return false;
  return !RESERVED_KEYS.includes(value);
}

/**
 * Bound on how much one integration may store.
 *
 * A publishable key is about 100 characters and a client id about 70. This is
 * generous and it stops a malformed client turning one settings row into a
 * storage problem.
 */
export const MAX_INTEGRATION_VALUE_LENGTH = 512;
export const MAX_INTEGRATION_FIELDS = 12;

function readStoredIntegration(value: unknown): StoredIntegration | null {
  if (!isRecord(value)) return null;

  const rawValues = isRecord(value["values"]) ? value["values"] : {};
  const values: Record<string, string> = {};

  for (const [key, entry] of Object.entries(rawValues)) {
    if (!isValidFieldKey(key)) continue;
    if (typeof entry !== "string") continue;
    if (entry.length > MAX_INTEGRATION_VALUE_LENGTH) continue;

    values[key] = entry;
    if (Object.keys(values).length >= MAX_INTEGRATION_FIELDS) break;
  }

  const rawSecrets = value["secretsPresent"];

  return {
    enabled: value["enabled"] === true,
    values,
    secretsPresent: Array.isArray(rawSecrets)
      ? rawSecrets.filter((entry): entry is string => typeof entry === "string").slice(0, 12)
      : [],
  };
}

function readIntegrations(value: unknown): Record<string, StoredIntegration> {
  if (!isRecord(value)) return {};

  const out: Record<string, StoredIntegration> = {};

  for (const [id, entry] of Object.entries(value)) {
    if (!isValidIntegrationId(id)) continue;

    const stored = readStoredIntegration(entry);
    if (stored) out[id] = stored;
  }

  return out;
}

/**
 * Read one field definition out of untrusted JSON.
 *
 * Returns null rather than a partial definition. A field with no key cannot be
 * stored against a member and a field with no label cannot be rendered, so a
 * half-formed definition is worse than a missing one: the form would show an
 * unlabelled input that saves nowhere.
 */
function readFieldDefinition(value: unknown): CustomFieldDefinition | null {
  if (!isRecord(value)) return null;

  const key = typeof value["key"] === "string" ? value["key"] : "";
  if (!isValidFieldKey(key)) return null;

  const type = value["type"];
  if (typeof type !== "string" || !CUSTOM_FIELD_TYPES.includes(type as CustomFieldType)) {
    return null;
  }

  const label = typeof value["label"] === "string" ? value["label"].slice(0, 120) : "";
  if (label.trim() === "") return null;

  const options = Array.isArray(value["options"])
    ? value["options"]
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, MAX_FIELD_OPTIONS)
    : [];

  // A select with no options renders an empty dropdown, which a member cannot
  // satisfy and a required one would block them entirely.
  if (type === "select" && options.length === 0) return null;

  return {
    key,
    label,
    type: type as CustomFieldType,
    required: value["required"] === true,
    options,
    placeholder: typeof value["placeholder"] === "string" ? value["placeholder"].slice(0, 120) : "",
    order: typeof value["order"] === "number" && Number.isInteger(value["order"])
      ? value["order"]
      : 0,
  };
}

/**
 * Every valid definition, ordered, with duplicate keys collapsed.
 *
 * A duplicate key is not an error worth refusing the whole document over: two
 * definitions writing to one metadata key means the second silently wins, so
 * keeping the first and dropping the rest is the same outcome stated honestly.
 */
function readCustomFields(value: unknown): CustomFieldDefinition[] {
  if (!Array.isArray(value)) return [];

  const fields: CustomFieldDefinition[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const field = readFieldDefinition(entry);
    if (!field || seen.has(field.key)) continue;

    seen.add(field.key);
    fields.push(field);

    if (fields.length >= MAX_CUSTOM_FIELDS) break;
  }

  return fields.sort((left, right) => left.order - right.order);
}

function readGatedPages(value: unknown): GatedPageRule[] {
  if (!Array.isArray(value)) return [...DEFAULT_GATED_PAGES];

  const rules: GatedPageRule[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const pathVal = typeof entry["path"] === "string" ? entry["path"].trim() : "";
    if (!isSafeSitePath(pathVal) || seen.has(pathVal)) continue;

    const rawTier = entry["requiredTier"];
    const tier: GatedPageTier =
      typeof rawTier === "string" &&
      ["signed_in", "free_member", "tier_1", "tier_2", "vip"].includes(rawTier)
        ? (rawTier as GatedPageTier)
        : "signed_in";

    const rawFallback = entry["fallbackAction"];
    const fallback: GatedPageFallbackAction =
      typeof rawFallback === "string" &&
      ["redirect", "blur", "custom_card"].includes(rawFallback)
        ? (rawFallback as GatedPageFallbackAction)
        : "redirect";

    const redirectPath =
      typeof entry["redirectPath"] === "string" && isSafeSitePath(entry["redirectPath"])
        ? entry["redirectPath"]
        : undefined;

    seen.add(pathVal);
    const rule: GatedPageRule = {
      path: pathVal,
      enabled: entry["enabled"] !== false,
      requiredTier: tier,
      fallbackAction: fallback,
    };
    if (redirectPath !== undefined) {
      rule.redirectPath = redirectPath;
    }
    rules.push(rule);
  }

  return rules;
}

// ============================================================================
// READING
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

function bool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

function int(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

/**
 * A stored document, completed with defaults.
 *
 * Total: it accepts anything, including `null`, a string, or an array, and
 * returns a whole document. That matters because the input is a JSON column
 * whose contents nothing enforces, and the caller is a route that must answer
 * rather than throw. A corrupt row reads as defaults, which is wrong in the
 * safe direction: a creator sees their settings reset and says so, rather than
 * the panel failing to open.
 */
export function withDefaults(stored: unknown): SiteSettingsDocument {
  const base = defaultSettings();
  if (!isRecord(stored)) return base;

  const upgraded = upgrade(stored);

  const auth = isRecord(upgraded["auth"]) ? upgraded["auth"] : {};
  const branding = isRecord(upgraded["branding"]) ? upgraded["branding"] : {};
  const canvas = isRecord(upgraded["canvas"]) ? upgraded["canvas"] : {};

  const deployed = canvas["deployedComponents"];

  return {
    version: SETTINGS_SCHEMA_VERSION,
    auth: {
      loginPath: str(auth, "loginPath", base.auth.loginPath),
      signupPath: str(auth, "signupPath", base.auth.signupPath),
      resetPath: str(auth, "resetPath", base.auth.resetPath),
      afterLoginPath: str(auth, "afterLoginPath", base.auth.afterLoginPath),
      afterLogoutPath: str(auth, "afterLogoutPath", base.auth.afterLogoutPath),
      allowRegistration: bool(auth, "allowRegistration", base.auth.allowRegistration),
      defaultMethod:
        auth["defaultMethod"] === "otp" || auth["defaultMethod"] === "password"
          ? auth["defaultMethod"]
          : base.auth.defaultMethod,
      requirePasswordStrength: bool(
        auth,
        "requirePasswordStrength",
        base.auth.requirePasswordStrength
      ),
      rememberMeDays: int(auth, "rememberMeDays", base.auth.rememberMeDays),
    },
    branding: {
      displayName: str(branding, "displayName", base.branding.displayName),
      supportEmail: str(branding, "supportEmail", base.branding.supportEmail),
    },
    canvas: {
      lastDeployedAt:
        typeof canvas["lastDeployedAt"] === "string" ? canvas["lastDeployedAt"] : null,
      deployedComponents: Array.isArray(deployed)
        ? deployed.filter((entry): entry is string => typeof entry === "string")
        : [],
    },
    customFields: readCustomFields(upgraded["customFields"]),
    integrations: readIntegrations(upgraded["integrations"]),
    gatedPages: readGatedPages(upgraded["gatedPages"]),
  };
}

/**
 * Reinterpret a document written by an older schema version.
 *
 * Empty at version 1, and that is the correct contents rather than a stub: a
 * field that was merely added needs nothing here, because `withDefaults` fills
 * it. This exists for the case that one cannot cover, a field whose meaning
 * changed, and it is wired up now so the first such change is an edit rather
 * than a retrofit through every call site.
 */
function upgrade(stored: Record<string, unknown>): Record<string, unknown> {
  return stored;
}

// ============================================================================
// WRITING
// ============================================================================

/** One problem with one field, in words a creator can read. */
export interface SettingsProblem {
  path: string;
  message: string;
}

/**
 * Is this a site-relative path we are willing to redirect to?
 *
 * Exported because the plugin needs the same answer before it offers to save,
 * and because it is the single most security-relevant line in this file.
 *
 * It must start with exactly one `/`. Two is the trap: a browser reads `//evil.com`
 * as a protocol-relative URL and navigates off-site, so a check for "starts
 * with a slash" is an open redirect that looks like a path check. A backslash
 * is refused for the same reason, because some browsers normalise it to `/`.
 */
export function isSafeSitePath(value: string): boolean {
  if (value === "") return false;
  if (value.length > 512) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  if (value.includes("\\")) return false;
  // A control character in a redirect target is header-splitting material.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/**
 * The five settings that are site-relative paths.
 *
 * A tuple rather than `ReadonlyArray<keyof AuthSettings>`, so the element type
 * is the five string-valued keys and nothing else. Typed as the whole key union
 * it would include `allowRegistration`, and assigning a string through it
 * narrows to `never`: the compiler is right, and the fix is to say which keys
 * are meant rather than to cast past it.
 */
const PATH_FIELDS = [
  "loginPath",
  "signupPath",
  "resetPath",
  "afterLoginPath",
  "afterLogoutPath",
] as const;

/** The minimum and maximum a "remember me" window may be set to, in days. */
export const REMEMBER_ME_MIN_DAYS = 1;
export const REMEMBER_ME_MAX_DAYS = 365;

/**
 * Check a partial document before it is merged.
 *
 * Returns problems rather than throwing, so a route can answer with all of them
 * at once. A form that reports one problem per submit teaches a creator to
 * submit repeatedly.
 */
export function validatePatch(patch: unknown): SettingsProblem[] {
  const problems: SettingsProblem[] = [];

  if (!isRecord(patch)) {
    return [{ path: "", message: "Settings must be an object." }];
  }

  if (patch["auth"] !== undefined) {
    if (!isRecord(patch["auth"])) {
      problems.push({ path: "auth", message: "Auth settings must be an object." });
    } else {
      const auth = patch["auth"];

      for (const field of PATH_FIELDS) {
        const value = auth[field];
        if (value === undefined) continue;

        if (typeof value !== "string") {
          problems.push({ path: `auth.${field}`, message: "That must be a path, as text." });
          continue;
        }

        if (!isSafeSitePath(value)) {
          problems.push({
            path: `auth.${field}`,
            message: "Use a path on this site, starting with one slash, for example /login.",
          });
        }
      }

      if (auth["defaultMethod"] !== undefined) {
        if (auth["defaultMethod"] !== "password" && auth["defaultMethod"] !== "otp") {
          problems.push({
            path: "auth.defaultMethod",
            message: "Choose either the password form or the email code.",
          });
        }
      }

      for (const field of ["allowRegistration", "requirePasswordStrength"] as const) {
        if (auth[field] !== undefined && typeof auth[field] !== "boolean") {
          problems.push({ path: `auth.${field}`, message: "That must be on or off." });
        }
      }

      const days = auth["rememberMeDays"];
      if (days !== undefined) {
        if (typeof days !== "number" || !Number.isInteger(days)) {
          problems.push({ path: "auth.rememberMeDays", message: "That must be a whole number of days." });
        } else if (days < REMEMBER_ME_MIN_DAYS || days > REMEMBER_ME_MAX_DAYS) {
          problems.push({
            path: "auth.rememberMeDays",
            message: `Choose between ${REMEMBER_ME_MIN_DAYS} and ${REMEMBER_ME_MAX_DAYS} days.`,
          });
        }
      }
    }
  }

  if (patch["integrations"] !== undefined) {
    if (!isRecord(patch["integrations"])) {
      problems.push({ path: "integrations", message: "Integrations must be an object." });
    } else {
      for (const [id, entry] of Object.entries(patch["integrations"])) {
        if (!isValidIntegrationId(id)) {
          problems.push({ path: `integrations.${id}`, message: "That is not a valid integration." });
          continue;
        }

        if (!isRecord(entry)) {
          problems.push({ path: `integrations.${id}`, message: "That integration must be an object." });
          continue;
        }

        if (entry["values"] !== undefined && !isRecord(entry["values"])) {
          problems.push({
            path: `integrations.${id}.values`,
            message: "Integration values must be an object.",
          });
        }
      }
    }
  }

  if (patch["customFields"] !== undefined) {
    if (!Array.isArray(patch["customFields"])) {
      problems.push({ path: "customFields", message: "Custom fields must be a list." });
    } else if (patch["customFields"].length > MAX_CUSTOM_FIELDS) {
      problems.push({
        path: "customFields",
        message: `A site can have at most ${MAX_CUSTOM_FIELDS} custom fields.`,
      });
    } else {
      const keys = new Set<string>();

      patch["customFields"].forEach((entry, index) => {
        const field = readFieldDefinition(entry);

        if (!field) {
          problems.push({
            path: `customFields.${index}`,
            message:
              "Each field needs a label, a type, and a key of lowercase letters, digits, and underscores. A dropdown also needs options.",
          });
          return;
        }

        if (keys.has(field.key)) {
          // Worth refusing rather than collapsing on the write path: a creator
          // editing the list should be told, where a document read from the
          // database is only being salvaged.
          problems.push({
            path: `customFields.${index}`,
            message: `Two fields share the key "${field.key}".`,
          });
          return;
        }

        keys.add(field.key);
      });
    }
  }

  if (patch["branding"] !== undefined) {
    if (!isRecord(patch["branding"])) {
      problems.push({ path: "branding", message: "Branding settings must be an object." });
    } else {
      for (const field of ["displayName", "supportEmail"] as const) {
        const value = patch["branding"][field];
        if (value === undefined) continue;

        if (typeof value !== "string") {
          problems.push({ path: `branding.${field}`, message: "That must be text." });
        } else if (value.length > 255) {
          problems.push({ path: `branding.${field}`, message: "That is too long." });
        }
      }
    }
  }

  if (patch["gatedPages"] !== undefined) {
    if (!Array.isArray(patch["gatedPages"])) {
      problems.push({ path: "gatedPages", message: "Gated pages must be a list." });
    } else {
      patch["gatedPages"].forEach((entry, index) => {
        if (!isRecord(entry) || typeof entry["path"] !== "string" || !isSafeSitePath(entry["path"])) {
          problems.push({
            path: `gatedPages.${index}.path`,
            message: "Each page rule needs a valid path starting with a slash, for example /dashboard.",
          });
        }
      });
    }
  }

  return problems;
}

/**
 * Apply a partial document to a complete one.
 *
 * One level of nesting, per key, and no deeper. That is enough for this shape
 * and it avoids a general deep merge, which has a well-known hazard: a key
 * named `__proto__` or `constructor` in attacker-supplied JSON walks up the
 * prototype chain and changes objects the merge was never given. Enumerating
 * the sections by name means a key nobody declared cannot be written at all.
 *
 * `canvas.deployedComponents` replaces rather than concatenates. It is a
 * statement of what is currently deployed, not a log.
 */
export function mergeSettings(
  current: SiteSettingsDocument,
  patch: unknown
): SiteSettingsDocument {
  if (!isRecord(patch)) return current;

  const next: SiteSettingsDocument = {
    version: SETTINGS_SCHEMA_VERSION,
    auth: { ...current.auth },
    branding: { ...current.branding },
    canvas: { ...current.canvas, deployedComponents: [...current.canvas.deployedComponents] },
    customFields: current.customFields.map((field) => ({ ...field, options: [...field.options] })),
    gatedPages: current.gatedPages ? current.gatedPages.map((rule) => ({ ...rule })) : [...DEFAULT_GATED_PAGES],
    integrations: Object.fromEntries(
      Object.entries(current.integrations).map(([id, entry]) => [
        id,
        { enabled: entry.enabled, values: { ...entry.values }, secretsPresent: [...entry.secretsPresent] },
      ])
    ),
  };

  if (isRecord(patch["auth"])) {
    const auth = patch["auth"];

    for (const field of PATH_FIELDS) {
      const value = auth[field];
      if (typeof value === "string") next.auth[field] = value;
    }

    if (auth["defaultMethod"] === "password" || auth["defaultMethod"] === "otp") {
      next.auth.defaultMethod = auth["defaultMethod"];
    }

    if (typeof auth["allowRegistration"] === "boolean") {
      next.auth.allowRegistration = auth["allowRegistration"];
    }

    if (typeof auth["requirePasswordStrength"] === "boolean") {
      next.auth.requirePasswordStrength = auth["requirePasswordStrength"];
    }

    if (typeof auth["rememberMeDays"] === "number" && Number.isInteger(auth["rememberMeDays"])) {
      next.auth.rememberMeDays = auth["rememberMeDays"];
    }
  }

  if (isRecord(patch["branding"])) {
    const branding = patch["branding"];
    if (typeof branding["displayName"] === "string") {
      next.branding.displayName = branding["displayName"];
    }
    if (typeof branding["supportEmail"] === "string") {
      next.branding.supportEmail = branding["supportEmail"];
    }
  }

  if (isRecord(patch["integrations"])) {
    // Merged per integration id, so saving Stripe cannot disturb a Google
    // client id saved last week. Within one integration the values REPLACE
    // rather than merge: a creator clearing a field expects it gone, and a
    // per-key merge would make clearing impossible to express.
    for (const [id, entry] of Object.entries(patch["integrations"])) {
      if (!isValidIntegrationId(id) || !isRecord(entry)) continue;

      const incoming = readStoredIntegration(entry);
      if (!incoming) continue;

      // secretsPresent is never taken from a client. It is this server's
      // statement about what it holds, and a client that could assert it could
      // make a card claim a connection that does not exist.
      next.integrations[id] = {
        enabled: incoming.enabled,
        values: incoming.values,
        secretsPresent: current.integrations[id]?.secretsPresent ?? [],
      };
    }
  }

  if (Array.isArray(patch["customFields"])) {
    // Replaced wholesale, not merged per field. The list IS the configuration:
    // a creator who deletes a field expects it gone, and a per-key merge would
    // make deletion impossible to express.
    next.customFields = readCustomFields(patch["customFields"]);
  }

  if (Array.isArray(patch["gatedPages"])) {
    next.gatedPages = readGatedPages(patch["gatedPages"]);
  }

  if (isRecord(patch["canvas"])) {
    const canvas = patch["canvas"];

    if (typeof canvas["lastDeployedAt"] === "string" || canvas["lastDeployedAt"] === null) {
      next.canvas.lastDeployedAt = canvas["lastDeployedAt"] as string | null;
    }

    if (Array.isArray(canvas["deployedComponents"])) {
      next.canvas.deployedComponents = canvas["deployedComponents"]
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 50);
    }
  }

  return next;
}

/**
 * Hand a document to Prisma.
 *
 * Prisma's `InputJsonValue` requires an index signature, which an interface
 * does not have, so a typed document cannot be assigned to a `Json` column
 * directly. A spread into a plain object is the honest conversion: every field
 * is named, so a field added to the interface and forgotten here fails the
 * typecheck rather than silently not being stored.
 *
 * The return type is Prisma's own, reached through a type-only import, so this
 * module still pulls in no database code at runtime and still tests without
 * one. `Record<string, unknown>` does not satisfy it: `unknown` is wider than
 * what a JSON column can hold, and the compiler is right to say so.
 *
 * This is also the only place that decides what reaches the column, which
 * answers the question a JSON column always raises: could a secret end up in
 * here? Not by accident. Nothing is copied that is not listed below, exactly as
 * `withDefaults` copies nothing on the way out that is not listed there. A
 * gateway key placed in the document by some future caller would be dropped at
 * both ends rather than stored and returned.
 */
export function toJsonDocument(document: SiteSettingsDocument): Prisma.InputJsonObject {
  return {
    version: document.version,
    auth: {
      loginPath: document.auth.loginPath,
      signupPath: document.auth.signupPath,
      resetPath: document.auth.resetPath,
      afterLoginPath: document.auth.afterLoginPath,
      afterLogoutPath: document.auth.afterLogoutPath,
      allowRegistration: document.auth.allowRegistration,
      defaultMethod: document.auth.defaultMethod,
      requirePasswordStrength: document.auth.requirePasswordStrength,
      rememberMeDays: document.auth.rememberMeDays,
    },
    branding: {
      displayName: document.branding.displayName,
      supportEmail: document.branding.supportEmail,
    },
    canvas: {
      lastDeployedAt: document.canvas.lastDeployedAt,
      deployedComponents: [...document.canvas.deployedComponents],
    },
    customFields: document.customFields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      options: [...field.options],
      placeholder: field.placeholder,
      order: field.order,
    })),
    gatedPages: (document.gatedPages ?? []).map((rule) => ({
      path: rule.path,
      enabled: rule.enabled,
      requiredTier: rule.requiredTier,
      fallbackAction: rule.fallbackAction,
      ...(rule.redirectPath !== undefined ? { redirectPath: rule.redirectPath } : {}),
    })),
    integrations: Object.fromEntries(
      Object.entries(document.integrations).map(([id, entry]) => [
        id,
        {
          enabled: entry.enabled,
          values: { ...entry.values },
          secretsPresent: [...entry.secretsPresent],
        },
      ])
    ),
  };
}
