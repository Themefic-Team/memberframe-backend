/**
 * Validating a member's custom field values. FP-09.
 *
 * The definitions live in the site settings document and the values live in
 * `Member.metadata`, a JSON column on the member's own row. This module is the
 * gate between the two, and it is the only thing that is: MySQL validates that
 * the column holds well-formed JSON and nothing whatever about its shape.
 *
 * ## Why validate against the definitions rather than a fixed schema
 *
 * Because the shape is the creator's, not ours. A design community's
 * `portfolio_url` and a coaching club's `team_size` are the same column, so the
 * only thing that can say whether a value is acceptable is the definition the
 * creator wrote. A fixed schema here would mean either accepting anything,
 * which puts a creator's form at the mercy of whatever a visitor posts, or
 * guessing at types, which is worse.
 *
 * ## What it refuses, and why that list is short
 *
 * A key with no definition is dropped rather than rejected. A member whose
 * browser posts a stale form after the creator deleted a field should not be
 * told their profile is invalid; the field is gone, so the value goes too.
 *
 * A value of the wrong type for its definition IS rejected, with the field
 * named, because that one is actionable: it means the form and the definition
 * disagree, and a member can fix what they typed.
 */

import type { CustomFieldDefinition } from "./siteSettings.js";

/** What a member's metadata column may hold. */
export type MetadataValue = string | number | boolean | null;
export type MemberMetadata = Record<string, MetadataValue>;

export interface MetadataProblem {
  key: string;
  message: string;
}

export interface MetadataResult {
  metadata: MemberMetadata;
  problems: MetadataProblem[];
}

/** Bounds, chosen so one member's profile cannot become a storage problem. */
export const MAX_TEXT_LENGTH = 255;
export const MAX_TEXTAREA_LENGTH = 2000;
export const MAX_URL_LENGTH = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is this a URL we are willing to store and later render as a link?
 *
 * http and https only. The refusal that matters is `javascript:`: a portfolio
 * URL is rendered as an anchor on the creator's site and in the plugin's member
 * flyout, and `javascript:` in an href is script execution in both places. Any
 * other scheme is refused too rather than enumerated, because the list of
 * dangerous ones is open-ended and the list of useful ones is two.
 */
export function isSafeUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * E.164, loosely.
 *
 * A leading plus and 7 to 15 digits. Deliberately not a full national-format
 * parser: those reject real numbers, and the cost of being permissive here is a
 * creator seeing a badly formatted number in their member list, which is a
 * nuisance rather than a defect.
 */
export function isPhoneLike(value: string): boolean {
  return /^\+?[0-9][0-9\s\-().]{5,24}$/.test(value);
}

/**
 * Check one value against one definition.
 *
 * Returns the value to store, or a problem. An empty string becomes null
 * throughout: a member who clears a field means "I have no value for this", and
 * storing `""` would make the difference between cleared and never-filled
 * invisible to every consumer.
 */
function checkValue(
  field: CustomFieldDefinition,
  raw: unknown
): { value: MetadataValue } | { problem: string } {
  if (raw === null || raw === undefined) {
    return field.required ? { problem: `${field.label} is required.` } : { value: null };
  }

  switch (field.type) {
    case "boolean": {
      if (typeof raw !== "boolean") return { problem: `${field.label} must be on or off.` };
      // A required boolean means the box must be ticked, which is how a terms
      // checkbox is expressed. `false` is a value, so this is checked here
      // rather than by the null branch above.
      if (field.required && !raw) return { problem: `${field.label} is required.` };
      return { value: raw };
    }

    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { problem: `${field.label} must be a number.` };
      }
      return { value: raw };
    }

    case "select": {
      if (typeof raw !== "string") return { problem: `${field.label} must be one of the options.` };
      if (raw === "") {
        return field.required ? { problem: `${field.label} is required.` } : { value: null };
      }
      // Against the definition's own list. Without this a member could post any
      // string and the creator's "Industry" column would fill with free text.
      if (!field.options.includes(raw)) {
        return { problem: `${field.label} must be one of the options.` };
      }
      return { value: raw };
    }

    case "url": {
      if (typeof raw !== "string") return { problem: `${field.label} must be a web address.` };
      const trimmed = raw.trim();
      if (trimmed === "") {
        return field.required ? { problem: `${field.label} is required.` } : { value: null };
      }
      if (!isSafeUrl(trimmed)) {
        return { problem: `${field.label} must be a web address starting with https://.` };
      }
      return { value: trimmed };
    }

    case "phone": {
      if (typeof raw !== "string") return { problem: `${field.label} must be a phone number.` };
      const trimmed = raw.trim();
      if (trimmed === "") {
        return field.required ? { problem: `${field.label} is required.` } : { value: null };
      }
      if (!isPhoneLike(trimmed)) return { problem: `${field.label} does not look like a number.` };
      return { value: trimmed };
    }

    case "textarea":
    case "text": {
      if (typeof raw !== "string") return { problem: `${field.label} must be text.` };
      const trimmed = raw.trim();
      if (trimmed === "") {
        return field.required ? { problem: `${field.label} is required.` } : { value: null };
      }
      const limit = field.type === "textarea" ? MAX_TEXTAREA_LENGTH : MAX_TEXT_LENGTH;
      if (trimmed.length > limit) return { problem: `${field.label} is too long.` };
      return { value: trimmed };
    }

    default:
      // Unreachable while `CustomFieldType` is closed, and present so that
      // adding a type without handling it fails here rather than silently
      // accepting anything for the new type.
      return { problem: `${field.label} cannot be saved.` };
  }
}

/**
 * Apply a submitted patch to a member's stored metadata.
 *
 * A merge rather than a replacement, keyed on what the patch actually contains.
 * The dashboard's profile form may show three of eight fields, and a
 * replacement would clear the other five. Sending an explicit `null` is how a
 * member clears one.
 *
 * Fields the creator has since deleted are dropped from the stored object, so
 * the column does not accumulate values for fields nobody can see or edit.
 */
export function applyMetadata(
  fields: ReadonlyArray<CustomFieldDefinition>,
  stored: unknown,
  patch: unknown
): MetadataResult {
  const current = isRecord(stored) ? stored : {};
  const incoming = isRecord(patch) ? patch : {};

  const metadata: MemberMetadata = {};
  const problems: MetadataProblem[] = [];

  for (const field of fields) {
    const submitted = Object.prototype.hasOwnProperty.call(incoming, field.key);
    const raw = submitted ? incoming[field.key] : current[field.key];

    // Not submitted and not stored. A required field is only enforced when the
    // member is actually editing: enforcing it on every read would lock a
    // member out of their own profile the moment a creator adds a required
    // field to an established site.
    if (!submitted && raw === undefined) continue;

    const result = checkValue(field, raw ?? null);

    if ("problem" in result) {
      // Only when the member submitted it. A stored value that no longer
      // satisfies a changed definition is kept rather than reported: the
      // creator changed the rule, and the member did nothing wrong.
      if (submitted) {
        problems.push({ key: field.key, message: result.problem });
      } else if (raw !== undefined) {
        metadata[field.key] = raw as MetadataValue;
      }
      continue;
    }

    if (result.value !== null) metadata[field.key] = result.value;
  }

  return { metadata, problems };
}

/**
 * The member-facing view of the definitions.
 *
 * `order` is dropped because the array is already in that order, and sending a
 * sort key invites a client to sort by it differently. Everything else is
 * needed to render the control.
 */
export function publicFieldDefinitions(
  fields: ReadonlyArray<CustomFieldDefinition>
): Array<Omit<CustomFieldDefinition, "order">> {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: [...field.options],
    placeholder: field.placeholder,
  }));
}
