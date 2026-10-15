/**
 * Custom profile field values. FP-09.
 *
 * The definitions are the creator's and the values are the member's, and this
 * module is the only thing between a posted form and a JSON column that
 * validates nothing. So the tests here are about the three ways that goes
 * wrong:
 *
 *   1. A value that is dangerous to store, which is one specific case: a
 *      `javascript:` URL, because a portfolio link is rendered as an anchor on
 *      the creator's site and in the plugin's member flyout.
 *   2. A value that does not match its definition, which must be reported
 *      rather than coerced.
 *   3. A patch that clears fields it never mentioned, which would silently
 *      delete a member's profile every time a partial form was submitted.
 */

import { describe, expect, it } from "vitest";
import {
  applyMetadata,
  isPhoneLike,
  isSafeUrl,
  publicFieldDefinitions,
} from "../src/lib/memberMetadata.js";
import type { CustomFieldDefinition } from "../src/lib/siteSettings.js";

function field(over: Partial<CustomFieldDefinition>): CustomFieldDefinition {
  return {
    key: "company",
    label: "Company",
    type: "text",
    required: false,
    options: [],
    placeholder: "",
    order: 0,
    ...over,
  };
}

describe("isSafeUrl", () => {
  it("accepts http and https", () => {
    expect(isSafeUrl("https://jordan.design")).toBe(true);
    expect(isSafeUrl("http://localhost:3000/portfolio")).toBe(true);
  });

  it("refuses javascript:, which is the case that matters", () => {
    // A portfolio URL is rendered as an anchor in two places we control. A
    // `javascript:` href is script execution in both.
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("JavaScript:alert(1)")).toBe(false);
  });

  it("refuses every other scheme rather than enumerating the bad ones", () => {
    for (const value of ["data:text/html,<script>", "file:///etc/passwd", "vbscript:x"]) {
      expect(isSafeUrl(value)).toBe(false);
    }
  });

  it("refuses what is not a URL, including a bare domain", () => {
    expect(isSafeUrl("jordan.design")).toBe(false);
    expect(isSafeUrl("")).toBe(false);
  });

  it("refuses an over-long URL", () => {
    expect(isSafeUrl(`https://a.test/${"x".repeat(3000)}`)).toBe(false);
  });
});

describe("isPhoneLike", () => {
  it("accepts the forms people actually type", () => {
    for (const value of ["+44 20 7946 0958", "+1 (555) 123-4567", "07700900123"]) {
      expect(isPhoneLike(value)).toBe(true);
    }
  });

  it("refuses text and a number that is far too short", () => {
    expect(isPhoneLike("call me")).toBe(false);
    expect(isPhoneLike("123")).toBe(false);
  });
});

describe("applyMetadata", () => {
  it("keeps a stored value the patch does not mention", () => {
    // The property that stops a partial form wiping a profile. The dashboard
    // may show three of eight fields.
    const fields = [field({ key: "company" }), field({ key: "role", label: "Role" })];

    const result = applyMetadata(fields, { company: "Acme", role: "Designer" }, {
      company: "Acme Design Co",
    });

    expect(result.problems).toEqual([]);
    expect(result.metadata).toEqual({ company: "Acme Design Co", role: "Designer" });
  });

  it("clears a field with an explicit null", () => {
    const fields = [field({ key: "company" })];
    const result = applyMetadata(fields, { company: "Acme" }, { company: null });

    expect(result.problems).toEqual([]);
    expect(result.metadata).not.toHaveProperty("company");
  });

  it("treats an empty string as cleared rather than storing it", () => {
    // Otherwise "cleared" and "never filled in" are two different stored
    // states that mean the same thing, and every consumer has to know both.
    const fields = [field({ key: "company" })];
    const result = applyMetadata(fields, { company: "Acme" }, { company: "   " });

    expect(result.metadata).not.toHaveProperty("company");
  });

  it("drops a key with no definition", () => {
    // A stale form posted after the creator deleted the field. Dropping is
    // right; telling the member their profile is invalid is not.
    const result = applyMetadata([field({ key: "company" })], {}, {
      company: "Acme",
      deleted_field: "value",
      __proto__: { polluted: true },
    });

    expect(result.metadata).toEqual({ company: "Acme" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("drops a stored value whose definition was deleted", () => {
    const result = applyMetadata([field({ key: "company" })], { company: "Acme", old: "x" }, {});

    expect(result.metadata).toEqual({ company: "Acme" });
  });

  it("reports a required field the member left blank", () => {
    const fields = [field({ key: "company", required: true })];
    const result = applyMetadata(fields, {}, { company: "" });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.key).toBe("company");
    // The label, not the key. PRD section 7.6 rule 4.
    expect(result.problems[0]?.message).toContain("Company");
  });

  it("does not enforce a required field the member is not editing", () => {
    // A creator adding a required field to an established site must not lock
    // every existing member out of saving anything else.
    const fields = [field({ key: "company", required: true }), field({ key: "role", label: "Role" })];
    const result = applyMetadata(fields, {}, { role: "Designer" });

    expect(result.problems).toEqual([]);
    expect(result.metadata).toEqual({ role: "Designer" });
  });

  it("requires a boolean to be ticked when it is required", () => {
    // How a terms checkbox is expressed. `false` is a value, so the null
    // branch would not have caught it.
    const fields = [field({ key: "terms", label: "Terms", type: "boolean", required: true })];

    expect(applyMetadata(fields, {}, { terms: false }).problems).toHaveLength(1);
    expect(applyMetadata(fields, {}, { terms: true }).problems).toEqual([]);
  });

  it("refuses a select value that is not one of the options", () => {
    // Without this a member could post any string and the creator's "Industry"
    // column would fill with free text.
    const fields = [
      field({ key: "industry", label: "Industry", type: "select", options: ["Design", "SaaS"] }),
    ];

    expect(applyMetadata(fields, {}, { industry: "Anything" }).problems).toHaveLength(1);
    expect(applyMetadata(fields, {}, { industry: "SaaS" }).metadata).toEqual({ industry: "SaaS" });
  });

  it("refuses an unsafe URL", () => {
    const fields = [field({ key: "site", label: "Portfolio", type: "url" })];

    expect(applyMetadata(fields, {}, { site: "javascript:alert(1)" }).problems).toHaveLength(1);
    expect(applyMetadata(fields, {}, { site: "https://a.test" }).metadata).toEqual({
      site: "https://a.test",
    });
  });

  it("refuses a value of the wrong type", () => {
    const fields = [field({ key: "size", label: "Team size", type: "number" })];

    expect(applyMetadata(fields, {}, { size: "twelve" }).problems).toHaveLength(1);
    expect(applyMetadata(fields, {}, { size: Number.NaN }).problems).toHaveLength(1);
    expect(applyMetadata(fields, {}, { size: 12 }).metadata).toEqual({ size: 12 });
  });

  it("keeps a stored value that a changed definition would now refuse", () => {
    // The creator tightened the rule. The member did nothing wrong and should
    // not be told their saved profile is invalid while editing something else.
    const fields = [
      field({ key: "industry", type: "select", options: ["Design"], label: "Industry" }),
    ];

    const result = applyMetadata(fields, { industry: "Removed option" }, {});

    expect(result.problems).toEqual([]);
    expect(result.metadata).toEqual({ industry: "Removed option" });
  });

  it("bounds a long text value", () => {
    const fields = [field({ key: "company" })];
    expect(applyMetadata(fields, {}, { company: "x".repeat(300) }).problems).toHaveLength(1);
  });

  it("survives stored data that is not an object", () => {
    // The column is JSON and nothing enforces its shape. A row written by hand
    // is exactly how it stops being an object.
    for (const stored of [null, "oops", 7, []]) {
      expect(applyMetadata([field({})], stored, { company: "Acme" }).metadata).toEqual({
        company: "Acme",
      });
    }
  });
});

describe("publicFieldDefinitions", () => {
  it("drops the sort key and copies the options", () => {
    const fields = [field({ key: "industry", type: "select", options: ["A"], order: 3 })];
    const published = publicFieldDefinitions(fields);

    expect(published[0]).not.toHaveProperty("order");
    expect(published[0]?.options).toEqual(["A"]);

    // A copy, not the same array: a caller mutating the response must not
    // change the settings document it came from.
    published[0]?.options.push("B");
    expect(fields[0]?.options).toEqual(["A"]);
  });
});
