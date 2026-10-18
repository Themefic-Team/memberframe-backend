/**
 * The settings document.
 *
 * This is the module that pays for the decision to keep every setting in one
 * JSON column instead of a column per switch. The database validates nothing
 * about the shape, so everything a `NOT NULL` or a `CHECK` would have caught is
 * caught here or not at all, and these tests are the proof that it is here.
 *
 * Four properties matter, and each has a failure mode worth naming:
 *
 *   1. A read is total. A corrupt row must produce a whole document, not an
 *      exception, because the caller is a route that has to answer.
 *   2. A write merges. A panel that knows four settings must not erase a fifth
 *      it has never heard of, which is what makes an older plugin safe.
 *   3. A path is a path. `isSafeSitePath` is the open-redirect check and the
 *      most security-relevant function in the file.
 *   4. Nothing undeclared is stored or returned.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTH_SETTINGS,
  REMEMBER_ME_MAX_DAYS,
  REMEMBER_ME_MIN_DAYS,
  SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  isSafeSitePath,
  mergeSettings,
  toJsonDocument,
  validatePatch,
  withDefaults,
  sectionLockSlug,
} from "../src/lib/siteSettings.js";

describe("withDefaults is total", () => {
  it("returns a whole document for every kind of garbage", () => {
    // Each of these is a plausible contents of a JSON column that nothing
    // validated: a row hand-edited in Prisma Studio, a bad migration, a write
    // from a version that stored something else entirely.
    for (const input of [null, undefined, 7, "hello", true, [], [1, 2, 3]]) {
      const document = withDefaults(input);

      expect(document.auth.loginPath).toBe(DEFAULT_AUTH_SETTINGS.loginPath);
      expect(document.branding.displayName).toBe("");
      expect(document.canvas.deployedComponents).toEqual([]);
      expect(document.version).toBe(SETTINGS_SCHEMA_VERSION);
    }
  });

  it("keeps the fields that are there and defaults the ones that are not", () => {
    // The real case this covers: a document written before `rememberMeDays`
    // existed. It must read back with the new field at its default rather than
    // as undefined, so no consumer has to write `?? 30` at every call site.
    const document = withDefaults({ auth: { loginPath: "/members/sign-in" } });

    expect(document.auth.loginPath).toBe("/members/sign-in");
    expect(document.auth.rememberMeDays).toBe(DEFAULT_AUTH_SETTINGS.rememberMeDays);
    expect(document.auth.allowRegistration).toBe(true);
  });

  it("replaces a field of the wrong type with its default", () => {
    const document = withDefaults({
      auth: { loginPath: 42, allowRegistration: "yes", rememberMeDays: 1.5 },
    });

    expect(document.auth.loginPath).toBe(DEFAULT_AUTH_SETTINGS.loginPath);
    expect(document.auth.allowRegistration).toBe(true);
    // 1.5 is a number but not an integer, and a fractional day is not a thing
    // the session code can use.
    expect(document.auth.rememberMeDays).toBe(DEFAULT_AUTH_SETTINGS.rememberMeDays);
  });

  it("drops a field nobody declared", () => {
    // The guarantee that makes a JSON column safe to return to a panel whole:
    // a key that is not in the shape does not survive a read, so a secret put
    // there by mistake cannot be handed back out.
    const document = withDefaults({
      auth: { loginPath: "/login", stripeSecretKey: "sk_live_abc123" },
    });

    expect(JSON.stringify(document)).not.toContain("sk_live_abc123");
    expect(JSON.stringify(document)).not.toContain("stripeSecretKey");
  });

  it("keeps only the strings out of a deployedComponents array", () => {
    const document = withDefaults({
      canvas: { deployedComponents: ["MemberGate", 7, null, "MemberAuth"] },
    });

    expect(document.canvas.deployedComponents).toEqual(["MemberGate", "MemberAuth"]);
  });
});

describe("isSafeSitePath", () => {
  it("accepts an ordinary site path", () => {
    for (const path of ["/login", "/", "/members/sign-in", "/a/b/c?next=1"]) {
      expect(isSafeSitePath(path)).toBe(true);
    }
  });

  it("refuses a protocol-relative URL, which is the whole point of this check", () => {
    // `//evil.com` starts with a slash and is NOT a path: a browser reads it as
    // protocol-relative and navigates off-site. A check for "starts with /" is
    // an open redirect wearing a path check's clothes, and this is the case
    // that distinguishes the two.
    expect(isSafeSitePath("//evil.com")).toBe(false);
    expect(isSafeSitePath("//evil.com/login")).toBe(false);
  });

  it("refuses an absolute URL", () => {
    for (const path of ["https://evil.com", "http://evil.com", "javascript:alert(1)"]) {
      expect(isSafeSitePath(path)).toBe(false);
    }
  });

  it("refuses a backslash, which some browsers normalise to a slash", () => {
    expect(isSafeSitePath("/\\evil.com")).toBe(false);
    expect(isSafeSitePath("/a\\b")).toBe(false);
  });

  it("refuses a control character", () => {
    // A newline in a redirect target is header-splitting material if the value
    // ever reaches a Location header.
    expect(isSafeSitePath("/login\nSet-Cookie: a=b")).toBe(false);
    expect(isSafeSitePath("/login\r\n")).toBe(false);
  });

  it("refuses empty and over-long", () => {
    expect(isSafeSitePath("")).toBe(false);
    expect(isSafeSitePath(`/${"a".repeat(600)}`)).toBe(false);
  });
});

describe("validatePatch", () => {
  it("passes a patch that only touches what it means to", () => {
    expect(validatePatch({ auth: { loginPath: "/signin" } })).toEqual([]);
    expect(validatePatch({})).toEqual([]);
  });

  it("names every problem rather than only the first", () => {
    // A form that reports one problem per submit teaches a creator to submit
    // repeatedly, which is why this returns a list.
    const problems = validatePatch({
      auth: { loginPath: "//evil.com", afterLoginPath: "https://evil.com", rememberMeDays: 0 },
    });

    const paths = problems.map((problem) => problem.path);
    expect(paths).toContain("auth.loginPath");
    expect(paths).toContain("auth.afterLoginPath");
    expect(paths).toContain("auth.rememberMeDays");
  });

  it("bounds the remember-me window at both ends", () => {
    expect(validatePatch({ auth: { rememberMeDays: REMEMBER_ME_MIN_DAYS } })).toEqual([]);
    expect(validatePatch({ auth: { rememberMeDays: REMEMBER_ME_MAX_DAYS } })).toEqual([]);
    expect(validatePatch({ auth: { rememberMeDays: REMEMBER_ME_MAX_DAYS + 1 } })).toHaveLength(1);
    expect(validatePatch({ auth: { rememberMeDays: REMEMBER_ME_MIN_DAYS - 1 } })).toHaveLength(1);
  });

  it("refuses an auth method that is neither", () => {
    expect(validatePatch({ auth: { defaultMethod: "sms" } })).toHaveLength(1);
    expect(validatePatch({ auth: { defaultMethod: "otp" } })).toEqual([]);
  });

  it("refuses a non-object document", () => {
    expect(validatePatch("hello")).toHaveLength(1);
    expect(validatePatch(null)).toHaveLength(1);
  });
});

describe("mergeSettings", () => {
  it("changes only what the patch names", () => {
    // The property that makes an older plugin safe rather than destructive:
    // a panel that has never heard of `requirePasswordStrength` and sends only
    // a login path must not reset it.
    const current = defaultSettings();
    const next = mergeSettings(current, { auth: { loginPath: "/enter" } });

    expect(next.auth.loginPath).toBe("/enter");
    expect(next.auth.requirePasswordStrength).toBe(current.auth.requirePasswordStrength);
    expect(next.auth.rememberMeDays).toBe(current.auth.rememberMeDays);
    expect(next.branding).toEqual(current.branding);
  });

  it("does not mutate the document it was given", () => {
    const current = defaultSettings();
    const before = JSON.stringify(current);

    mergeSettings(current, { auth: { loginPath: "/enter" }, canvas: { deployedComponents: ["X"] } });

    expect(JSON.stringify(current)).toBe(before);
  });

  it("ignores a key nobody declared", () => {
    const next = mergeSettings(defaultSettings(), {
      auth: { loginPath: "/enter", stripeSecretKey: "sk_live_x" },
      somethingElse: { a: 1 },
    });

    expect(JSON.stringify(next)).not.toContain("sk_live_x");
    expect(JSON.stringify(next)).not.toContain("somethingElse");
  });

  it("cannot be used to reach the prototype", () => {
    // The hazard a general deep merge has and this one does not. Enumerating
    // the sections by name means `__proto__` is simply not one of them.
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    mergeSettings(defaultSettings(), polluted);

    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

    const nested = JSON.parse('{"auth": {"__proto__": {"polluted2": true}}}') as unknown;
    mergeSettings(defaultSettings(), nested);

    expect(({} as Record<string, unknown>)["polluted2"]).toBeUndefined();
  });

  it("replaces deployedComponents rather than appending", () => {
    // It is a statement of what is deployed now, not a log of what ever was.
    const current = mergeSettings(defaultSettings(), {
      canvas: { deployedComponents: ["MemberGate"] },
    });

    const next = mergeSettings(current, { canvas: { deployedComponents: ["MemberAuth"] } });

    expect(next.canvas.deployedComponents).toEqual(["MemberAuth"]);
  });

  it("survives a patch that is not an object", () => {
    const current = defaultSettings();
    expect(mergeSettings(current, "nonsense")).toEqual(current);
    expect(mergeSettings(current, null)).toEqual(current);
  });
});

describe("toJsonDocument", () => {
  it("round trips through JSON unchanged", () => {
    // What actually happens: the object goes into a MySQL JSON column and comes
    // back out through `withDefaults`. If those two disagree, a creator saves a
    // setting and finds it reverted, with nothing logged anywhere.
    const document = mergeSettings(defaultSettings(), {
      auth: { loginPath: "/enter", rememberMeDays: 7, defaultMethod: "otp" },
      branding: { displayName: "Acme", supportEmail: "help@acme.test" },
      canvas: { lastDeployedAt: "2026-10-12T00:00:00.000Z", deployedComponents: ["MemberGate"] },
    });

    const stored = JSON.parse(JSON.stringify(toJsonDocument(document))) as unknown;

    expect(withDefaults(stored)).toEqual(document);
  });

  it("copies the array rather than sharing it", () => {
    const document = mergeSettings(defaultSettings(), {
      canvas: { deployedComponents: ["MemberGate"] },
    });

    const json = toJsonDocument(document);
    document.canvas.deployedComponents.push("MemberAuth");

    expect((json["canvas"] as { deployedComponents: string[] }).deployedComponents).toEqual([
      "MemberGate",
    ]);
  });
});

describe("gatedPages rules handling", () => {
  it("defaults to /dashboard and /private-content", () => {
    const doc = withDefaults(null);
    expect(doc.gatedPages).toHaveLength(2);
    expect(doc.gatedPages[0]!.path).toBe("/dashboard");
    expect(doc.gatedPages[0]!.enabled).toBe(true);
    expect(doc.gatedPages[1]!.path).toBe("/private-content");
  });

  it("validates that paths must be valid site paths", () => {
    const problems = validatePatch({
      gatedPages: [{ path: "invalid-no-slash", enabled: true, requiredTier: "signed_in", fallbackAction: "redirect" }],
    });
    expect(problems.some((p) => p.path === "gatedPages.0.path")).toBe(true);
  });

  it("merges custom gated pages correctly", () => {
    const current = defaultSettings();
    const next = mergeSettings(current, {
      gatedPages: [
        { path: "/tutorials", enabled: true, requiredTier: "tier_1", fallbackAction: "blur" },
      ],
    });
    expect(next.gatedPages).toHaveLength(1);
    expect(next.gatedPages[0]!.path).toBe("/tutorials");
    expect(next.gatedPages[0]!.requiredTier).toBe("tier_1");
    expect(next.gatedPages[0]!.fallbackAction).toBe("blur");
  });

  it("persists removing rule 2 through toJsonDocument and round trip", () => {
    const current = defaultSettings();
    // Simulate removing rule 2 (leaving only rule 1)
    const next = mergeSettings(current, {
      gatedPages: [current.gatedPages[0]],
    });
    expect(next.gatedPages).toHaveLength(1);

    const serialized = toJsonDocument(next);
    expect((serialized as { gatedPages: unknown[] }).gatedPages).toHaveLength(1);

    const stored = JSON.parse(JSON.stringify(serialized)) as unknown;
    const roundTripped = withDefaults(stored);

    expect(roundTripped.gatedPages).toHaveLength(1);
    expect(roundTripped.gatedPages[0]!.path).toBe("/dashboard");
  });

  it("persists empty gatedPages list through toJsonDocument and round trip", () => {
    const current = defaultSettings();
    const next = mergeSettings(current, {
      gatedPages: [],
    });
    expect(next.gatedPages).toHaveLength(0);

    const serialized = toJsonDocument(next);
    const stored = JSON.parse(JSON.stringify(serialized)) as unknown;
    const roundTripped = withDefaults(stored);

    expect(roundTripped.gatedPages).toHaveLength(0);
  });
});



// ============================================================================
// PROFILE FIELD CONDITIONS, FP-09 AND CONFLICT C31
// ============================================================================

describe("customFields showWhen", () => {
  const role = {
    key: "role",
    label: "Role",
    type: "select",
    required: true,
    options: ["Freelancer", "Agency"],
    placeholder: "",
    order: 0,
  };
  const team = {
    key: "team_size",
    label: "Team size",
    type: "number",
    required: false,
    options: [],
    placeholder: "",
    order: 1,
    showWhen: { key: "role", value: "Agency" },
  };

  it("accepts a condition on an earlier dropdown option", () => {
    expect(validatePatch({ customFields: [role, team] })).toEqual([]);
  });

  it("refuses a condition naming an option the dropdown lacks, with the field named", () => {
    const problems = validatePatch({
      customFields: [role, { ...team, showWhen: { key: "role", value: "Enterprise" } }],
    });

    expect(problems).toEqual([
      {
        path: "customFields.1.showWhen",
        message: "Choose one of the options of the dropdown this depends on.",
      },
    ]);
  });

  it("refuses a parent placed after the child", () => {
    const problems = validatePatch({
      customFields: [
        { ...team, order: 0 },
        { ...role, order: 1 },
      ],
    });

    expect(problems.map((problem) => problem.path)).toEqual(["customFields.0.showWhen"]);
  });

  it("refuses a chain of conditions", () => {
    const seats = {
      ...team,
      key: "seats",
      label: "Seats",
      order: 2,
      showWhen: { key: "team_size", value: "8" },
    };

    expect(validatePatch({ customFields: [role, team, seats] })).toHaveLength(1);
  });

  it("stores and returns the condition through the JSON column", () => {
    const document = mergeSettings(defaultSettings(), { customFields: [role, team] });
    const stored = JSON.parse(JSON.stringify(toJsonDocument(document))) as unknown;

    expect(withDefaults(stored).customFields[1]?.showWhen).toEqual({ key: "role", value: "Agency" });
    expect(withDefaults(stored).customFields[0]?.showWhen).toBeUndefined();
  });

  it("salvages a stored condition whose parent is gone by showing the field always", () => {
    // Refused on write, so this is a row edited by hand. Hiding the field
    // forever would be worse than showing it.
    const read = withDefaults({ customFields: [team] });

    expect(read.customFields).toHaveLength(1);
    expect(read.customFields[0]?.showWhen).toBeUndefined();
  });

  it("drops a malformed condition rather than the field", () => {
    const read = withDefaults({
      customFields: [role, { ...team, showWhen: { key: "Not A Key", value: "x" } }],
    });

    expect(read.customFields.map((field) => field.key)).toEqual(["role", "team_size"]);
    expect(read.customFields[1]?.showWhen).toBeUndefined();
  });
});

// ============================================================================
// INTEGRATION VALUE KEYS
// ============================================================================
// The regression: integration values were filtered with the custom field key
// rule, lowercase only, so `clientId` and every other camelCase key the plugin
// sends was dropped on merge while the save answered 200.

describe("integration values", () => {
  const github = {
    integrations: {
      github_oauth: {
        enabled: true,
        values: { clientId: "Ov23liABC", clientSecret: "shh", redirect_url: "https://x.test/cb" },
      },
    },
  };

  it("accepts the camelCase keys the plugin's registry uses", () => {
    expect(validatePatch(github)).toEqual([]);
  });

  it("stores them and reads them back, which is what the OAuth routes need", () => {
    const merged = mergeSettings(defaultSettings(), github);
    const stored = withDefaults(JSON.parse(JSON.stringify(toJsonDocument(merged))) as unknown);

    expect(stored.integrations["github_oauth"]?.values).toEqual({
      clientId: "Ov23liABC",
      clientSecret: "shh",
      redirect_url: "https://x.test/cb",
    });
    expect(stored.integrations["github_oauth"]?.enabled).toBe(true);
  });

  it("refuses a malformed key with the field named, instead of dropping it silently", () => {
    const problems = validatePatch({
      integrations: { github_oauth: { enabled: true, values: { "client.id": "x", __proto__x: "y" } } },
    });

    expect(problems.map((problem) => problem.path)).toContain("integrations.github_oauth.values.client.id");
  });

  it("still refuses prototype keys", () => {
    const values = JSON.parse('{"constructor":"x"}') as Record<string, string>;
    const problems = validatePatch({ integrations: { github_oauth: { enabled: true, values } } });

    expect(problems).toHaveLength(1);
  });
});

describe("section locks", () => {
  it("starts empty", () => {
    expect(defaultSettings().sectionLocks).toEqual([]);
    expect(withDefaults({}).sectionLocks).toEqual([]);
  });

  it("stores rules with tidy names and safe defaults", () => {
    const next = mergeSettings(defaultSettings(), {
      sectionLocks: [
        { name: "  Gold   article ", audience: "members", requiredTier: "tier_gold", lockedAction: "blur" },
        { name: "Teaser", audience: "others", requiredTier: "BAD TIER", lockedAction: "explode" },
      ],
    });

    expect(next.sectionLocks).toEqual([
      { name: "Gold article", enabled: true, audience: "members", requiredTier: "tier_gold", lockedAction: "blur" },
      { name: "Teaser", enabled: true, audience: "others", requiredTier: "signed_in", lockedAction: "hide" },
    ]);
  });

  it("refuses a name that could reach a selector unescaped, and duplicates", () => {
    for (const name of ['a"] , body {', `back${String.fromCharCode(92)}slash`, "", "-leading dash"]) {
      expect(validatePatch({ sectionLocks: [{ name }] }).some((p) => p.path === "sectionLocks.0.name"), name).toBe(true);
    }
    const dup = validatePatch({ sectionLocks: [{ name: "Gold" }, { name: "gold" }] });
    expect(dup.some((p) => p.path === "sectionLocks.1.name")).toBe(true);
  });

  it("drops invalid rules on read rather than storing them", () => {
    const doc = withDefaults({ sectionLocks: [{ name: 'x"]{}' }, { name: "Fine" }, { name: "fine" }] });
    expect(doc.sectionLocks.map((rule) => rule.name)).toEqual(["Fine"]);
  });

  it("survives the round trip", () => {
    const next = mergeSettings(defaultSettings(), { sectionLocks: [{ name: "Gold", requiredTier: "tier_gold" }] });
    const roundTripped = withDefaults(JSON.parse(JSON.stringify(toJsonDocument(next))));
    expect(roundTripped.sectionLocks).toEqual(next.sectionLocks);
  });
});

describe("section lock identity", () => {
  it("treats names that make the same tag as the same lock", () => {
    expect(sectionLockSlug("  Gold   Article ")).toBe("gold-article");
    expect(sectionLockSlug("v2.0 promo")).toBe("v2-0-promo");
    const dup = validatePatch({ sectionLocks: [{ name: "Gold Article" }, { name: "gold-article" }] });
    expect(dup.some((p) => p.path === "sectionLocks.1.name")).toBe(true);
  });
});
