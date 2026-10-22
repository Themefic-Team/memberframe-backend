/**
 * The Route Shield, run.
 *
 * `shield.test.ts` checks what the generated script contains. This file runs
 * it, in a small fake browser, and checks what it does: which pages it hides,
 * where it sends a visitor, and that in-site navigation is guarded as well as
 * the first page load. That last part is the bug this suite exists for: a
 * locked page was shut on a direct visit and open to anyone who clicked a link.
 */

import { describe, expect, it, vi } from "vitest";
import { generateShieldJs, shieldGuestPaths } from "../src/routes/shield.js";
import type { GatedPageRule, SectionLockRule } from "../src/lib/siteSettings.js";

const ORIGIN = "https://site.test";
const SITE_KEY = "mf_site_test";
const HINT_KEY = `memberframe:signed-in:${SITE_KEY}`;
const CACHE_KEY = `__mf_session_${SITE_KEY}`;

const RULES: GatedPageRule[] = [
  { path: "/dashboard", enabled: true, requiredTier: "signed_in", fallbackAction: "redirect", redirectPath: "/login" },
  { path: "/vip", enabled: true, requiredTier: "vip", fallbackAction: "redirect", redirectPath: "/pricing" },
];

const TIERS = [
  { key: "free_member" as const, rank: 0, name: "Free" },
  { key: "vip" as const, rank: 3, name: "VIP" },
];

const FREE_MEMBER = { memberId: "m1", email: "a@b.c", activeTier: "free_member", status: "active" };

type Answer = { status: number; body: unknown } | "pending" | "network_error";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
  };
}

/**
 * Boot the shield on `path`. Every session request takes the next answer from
 * `answers`. Timers are collected, not run, so a test can fire the timeout on
 * purpose.
 */
function boot(
  path: string,
  options: {
    answers?: Answer[];
    local?: Record<string, string>;
    session?: Record<string, string>;
    hash?: string;
    afterLoginPath?: string;
    rules?: GatedPageRule[];
    sectionRules?: SectionLockRule[];
    /** History methods on a History.prototype, the way a real browser has them. */
    prototypeHistory?: boolean;
  } = {}
) {
  const answers = [...(options.answers ?? [])];
  const head = {
    children: [] as Array<{ id: string; parentNode: unknown }>,
    appendChild(el: { id: string; parentNode: unknown }) {
      el.parentNode = head;
      head.children.push(el);
    },
    removeChild(el: { id: string; parentNode: unknown }) {
      head.children = head.children.filter((child) => child !== el);
      el.parentNode = null;
    },
  };

  const docListeners: Record<string, Array<(event: unknown) => void>> = {};
  const winListeners: Record<string, Array<(event: unknown) => void>> = {};
  const timers: Array<(() => void) | null> = [];

  const location = {
    pathname: path,
    hash: options.hash ?? "",
    origin: ORIGIN,
    get href() {
      return `${ORIGIN}${this.pathname}${this.hash}`;
    },
    replace: vi.fn(),
    reload: vi.fn(),
  };

  const go = (url: string) => {
    location.pathname = new URL(url, ORIGIN).pathname;
  };

  class FakeHistory {
    pushState(_state: unknown, _title: string, url: string) {
      go(url);
    }
    replaceState(_state: unknown, _title: string, url: string) {
      go(url);
    }
  }

  const window = {
    location,
    History: options.prototypeHistory ? FakeHistory : undefined,
    history: options.prototypeHistory
      ? (new FakeHistory() as unknown as Record<string, (...args: unknown[]) => void>)
      : {
          pushState: (_state: unknown, _title: string, url: string) => go(url),
          replaceState: (_state: unknown, _title: string, url: string) => go(url),
        },
    localStorage: memoryStorage(options.local),
    sessionStorage: memoryStorage(options.session),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (winListeners[type] ??= []).push(fn);
    },
  };

  const document = {
    head,
    documentElement: head,
    createElement: () => ({ id: "", textContent: "", parentNode: null }),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (docListeners[type] ??= []).push(fn);
    },
  };

  const fetch = vi.fn(() => {
    const answer = answers.shift() ?? "pending";
    if (answer === "pending") return new Promise(() => undefined);
    if (answer === "network_error") return Promise.reject(new Error("offline"));
    return Promise.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: () => Promise.resolve(answer.body),
    });
  });

  const setTimeout = (fn: () => void) => timers.push(fn);
  const clearTimeout = (id: number) => {
    timers[id - 1] = null;
  };

  const js = generateShieldJs({
    siteKey: SITE_KEY,
    apiBase: "https://api.test",
    loginPath: "/login",
    afterLoginPath: options.afterLoginPath ?? "/dashboard",
    guestPaths: ["/login", "/signup"],
    rules: options.rules ?? RULES,
    sectionRules: options.sectionRules ?? [],
    tiers: TIERS,
  });

  new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "URL", js)(
    window,
    document,
    fetch,
    setTimeout,
    clearTimeout,
    URL
  );

  return {
    window,
    location,
    fetch,
    hidden: () => head.children.some((child) => child.id === "memberframe-shield-veil"),
    /** The section lock stylesheet's current text. */
    sectionCss: () =>
      String((head.children.find((child) => child.id === "memberframe-section-locks") as { textContent?: string } | undefined)?.textContent ?? ""),
    fireTimers: () => {
      for (const fn of timers.splice(0)) fn?.();
    },
    /**
     * A link click. Delivered to window listeners only: on a published Framer
     * site, listeners the head script put on document did not survive the
     * page booting, so a hook that relies on them must fail this test.
     */
    click: (href: string) => {
      const anchor = { nodeName: "A", href, target: "", hasAttribute: () => false, parentNode: null };
      for (const fn of winListeners["click"] ?? []) {
        fn({ defaultPrevented: false, button: 0, target: anchor });
      }
    },
    docListeners,
    emit: (type: string, event: unknown) => {
      for (const fn of winListeners[type] ?? []) fn(event);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const signedIn = (member = FREE_MEMBER): Answer => ({ status: 200, body: { member, tiers: TIERS } });
const signedOut: Answer = { status: 401, body: { tiers: TIERS } };

describe("a locked page, loaded directly", () => {
  it("hides it at once and sends a signed-out visitor to the rule's redirect", async () => {
    const shield = boot("/dashboard", { answers: [signedOut] });
    expect(shield.hidden()).toBe(true);

    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("shows it to an entitled member, and remembers the session for the next page", async () => {
    const shield = boot("/dashboard", { answers: [signedIn()] });
    await flush();

    expect(shield.hidden()).toBe(false);
    expect(shield.location.replace).not.toHaveBeenCalled();
    expect(shield.window.sessionStorage.getItem(CACHE_KEY)).not.toBeNull();
    expect(shield.window.localStorage.getItem(HINT_KEY)).toBe("1");
  });

  it("sends a member without the plan to the plan's redirect", async () => {
    const shield = boot("/vip", { answers: [signedIn()] });
    await flush();

    expect(shield.location.replace).toHaveBeenCalledWith("/pricing");
  });

  const GOLD_TO_LOGIN: GatedPageRule[] = [
    ...RULES,
    { path: "/experiments", enabled: true, requiredTier: "vip", fallbackAction: "redirect", redirectPath: "/login" },
  ];

  it("sends a signed-in member without the plan to the dashboard, not to the sign in page", async () => {
    const shield = boot("/experiments", { answers: [signedIn()], rules: GOLD_TO_LOGIN });
    await flush();

    expect(shield.location.replace).toHaveBeenCalledTimes(1);
    expect(shield.location.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("still sends a signed-out visitor to the sign in page", async () => {
    const shield = boot("/experiments", { answers: [signedOut], rules: GOLD_TO_LOGIN });
    await flush();

    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("falls back to the home page when the dashboard is locked to the member too", async () => {
    const rules: GatedPageRule[] = [
      { path: "/dashboard", enabled: true, requiredTier: "vip", fallbackAction: "redirect", redirectPath: "/login" },
      { path: "/experiments", enabled: true, requiredTier: "vip", fallbackAction: "redirect", redirectPath: "/login" },
    ];
    const shield = boot("/experiments", { answers: [signedIn()], rules });
    await flush();

    expect(shield.location.replace).toHaveBeenCalledWith("/");
  });

  it("does the same on a menu click, from the cached session", () => {
    const cached = JSON.stringify({ ts: Date.now(), session: FREE_MEMBER, tiers: TIERS });
    const shield = boot("/", { session: { [CACHE_KEY]: cached }, rules: GOLD_TO_LOGIN });

    shield.window.history.pushState(null, "", "/experiments");
    expect(shield.location.replace).toHaveBeenCalledWith("/dashboard");
    expect(shield.fetch).not.toHaveBeenCalled();
  });

  it("never reveals the page when the check is slow: it redirects instead", () => {
    const shield = boot("/dashboard", { answers: ["pending"] });
    shield.fireTimers();

    expect(shield.hidden()).toBe(true);
    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("fails closed when the API cannot be reached", async () => {
    const shield = boot("/dashboard", { answers: ["network_error"] });
    await flush();

    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("covers nested paths under a locked one", async () => {
    const shield = boot("/dashboard/settings", { answers: [signedOut] });
    await flush();

    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });
});

describe("a CMS page rule, /blog/:slug", () => {
  const POSTS: GatedPageRule[] = [
    { path: "/blog/:slug", enabled: true, requiredTier: "signed_in", fallbackAction: "redirect", redirectPath: "/login" },
  ];

  it("locks every post", async () => {
    const shield = boot("/blog/how-e-commerce-is-redefining-global-shopping-trends", { answers: [signedOut], rules: POSTS });
    expect(shield.hidden()).toBe(true);

    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("leaves the list page open", () => {
    const shield = boot("/blog", { rules: POSTS });

    expect(shield.hidden()).toBe(false);
    expect(shield.fetch).not.toHaveBeenCalled();
  });

  it("does not match a different section with the same depth", () => {
    const shield = boot("/podcast/episode-1", { rules: POSTS });

    expect(shield.hidden()).toBe(false);
  });
});

describe("a public page", () => {
  it("is left alone, with no request", () => {
    const shield = boot("/about");

    expect(shield.hidden()).toBe(false);
    expect(shield.fetch).not.toHaveBeenCalled();
  });
});

describe("in-site navigation on a real Framer site", () => {
  // Reproduced in Chrome against a published site: a direct visit to a locked
  // page redirected, a click on the same page's menu link opened it. Framer
  // replaced history.pushState with its own function that calls the built-in
  // one, and the head script's document listeners were gone after boot.

  it("guards a router that installs its own pushState over the built-in one", async () => {
    const shield = boot("/", { answers: [signedOut], prototypeHistory: true });

    // What Framer does once it boots: its own pushState on the history object,
    // calling the method it finds on History.prototype.
    const builtIn = (shield.window.History as unknown as { prototype: { pushState: (...args: unknown[]) => void } })
      .prototype.pushState;
    shield.window.history.pushState = function (this: unknown, ...args: unknown[]) {
      builtIn.apply(this, args);
    };

    shield.window.history.pushState(null, "", "/dashboard");
    expect(shield.hidden()).toBe(true);

    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("keeps the locked page hidden and reloads when the redirect lands as an in-page navigation", async () => {
    const shield = boot("/", { answers: [signedOut] });
    // Framer's router, mid-transition, turns location.replace into an in-page
    // navigation: the URL changes and the locked page stays rendered.
    shield.location.replace.mockImplementation((url: string) => {
      shield.location.pathname = url;
    });

    shield.window.history.pushState(null, "", "/dashboard");
    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/login");

    // The hooks now see /login, a sign in page. The page must stay hidden.
    shield.fireTimers();
    expect(shield.hidden()).toBe(true);
    expect(shield.location.reload).toHaveBeenCalled();
  });

  it("hooks the click on window, not on document", () => {
    const shield = boot("/", { answers: ["pending"] });
    expect(shield.docListeners["click"] ?? []).toHaveLength(0);

    shield.click(`${ORIGIN}/dashboard`);
    expect(shield.hidden()).toBe(true);
  });

  it("catches a path change no hook saw, on the next poll", async () => {
    const shield = boot("/", { answers: [signedOut] });

    // A router this script knows nothing about.
    shield.location.pathname = "/dashboard";
    shield.fireTimers();
    expect(shield.hidden()).toBe(true);

    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });
});

describe("in-site navigation", () => {
  it("guards a locked page reached by pushState, not just by a full load", async () => {
    const shield = boot("/", { answers: [signedOut] });
    expect(shield.fetch).not.toHaveBeenCalled();

    shield.window.history.pushState(null, "", "/dashboard");
    expect(shield.hidden()).toBe(true);

    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("hides the page on the click itself, before the router renders the next one", () => {
    const shield = boot("/", { answers: ["pending"] });

    shield.click(`${ORIGIN}/dashboard`);
    expect(shield.hidden()).toBe(true);
  });

  it("does not hide for a link to a public page", () => {
    const shield = boot("/");

    shield.click(`${ORIGIN}/about`);
    expect(shield.hidden()).toBe(false);
  });

  it("guards the back button", async () => {
    const shield = boot("/", { answers: [signedOut] });

    shield.location.pathname = "/dashboard";
    shield.emit("popstate", {});
    expect(shield.hidden()).toBe(true);

    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/login");
  });

  it("lets an entitled member through on the cached session, without hiding", () => {
    const cached = JSON.stringify({ ts: Date.now(), session: FREE_MEMBER, tiers: TIERS });
    const shield = boot("/", { session: { [CACHE_KEY]: cached } });

    shield.click(`${ORIGIN}/dashboard`);
    shield.window.history.pushState(null, "", "/dashboard");

    expect(shield.hidden()).toBe(false);
    expect(shield.fetch).not.toHaveBeenCalled();
  });

  it("ignores a slow answer for a page the visitor already left", async () => {
    let settle: (value: unknown) => void = () => undefined;
    const shield = boot("/", { answers: [] });
    shield.fetch.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));

    shield.window.history.pushState(null, "", "/dashboard");
    shield.window.history.pushState(null, "", "/about");
    expect(shield.hidden()).toBe(false);

    settle({ status: 401, ok: false, json: () => Promise.resolve({}) });
    await flush();
    expect(shield.location.replace).not.toHaveBeenCalled();
  });

  it("drops the cached session when a component signs the member out", () => {
    const cached = JSON.stringify({ ts: Date.now(), session: FREE_MEMBER, tiers: TIERS });
    const shield = boot("/", { session: { [CACHE_KEY]: cached }, local: { [HINT_KEY]: "1" } });

    shield.emit("memberframe:session-updated", { detail: { signedIn: false } });

    expect(shield.window.sessionStorage.getItem(CACHE_KEY)).toBeNull();
    expect(shield.window.localStorage.getItem(HINT_KEY)).toBeNull();
  });
});

describe("the sign in page", () => {
  it("shows at once to a visitor who has never signed in here, with no request", () => {
    const shield = boot("/login");

    expect(shield.hidden()).toBe(false);
    expect(shield.fetch).not.toHaveBeenCalled();
  });

  it("sends a signed-in member to the After sign in page before the form paints", async () => {
    const shield = boot("/login", { local: { [HINT_KEY]: "1" }, answers: [signedIn()] });
    expect(shield.hidden()).toBe(true);

    await flush();
    expect(shield.location.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("shows the form when the hint was stale, and forgets the hint", async () => {
    const shield = boot("/login", { local: { [HINT_KEY]: "1" }, answers: [signedOut] });
    await flush();

    expect(shield.hidden()).toBe(false);
    expect(shield.location.replace).not.toHaveBeenCalled();
    expect(shield.window.localStorage.getItem(HINT_KEY)).toBeNull();
  });

  it("shows the form when the check is slow: a sign in form is not a secret", () => {
    const shield = boot("/login", { local: { [HINT_KEY]: "1" }, answers: ["pending"] });
    shield.fireTimers();

    expect(shield.hidden()).toBe(false);
  });

  it("does not loop a member whose After sign in page needs a plan they lack", async () => {
    const shield = boot("/login", {
      local: { [HINT_KEY]: "1" },
      answers: [signedIn()],
      afterLoginPath: "/vip",
    });
    await flush();

    expect(shield.location.replace).not.toHaveBeenCalled();
    expect(shield.hidden()).toBe(false);
  });

  it("leaves the social sign in tab alone while it finishes its handoff", () => {
    const shield = boot("/login", { local: { [HINT_KEY]: "1" }, hash: "#mf_oauth=abc" });

    expect(shield.hidden()).toBe(false);
    expect(shield.fetch).not.toHaveBeenCalled();
  });
});

describe("shieldGuestPaths", () => {
  it("keeps each sign in path once and never the home page", () => {
    expect(shieldGuestPaths(["/login", "/login/", "/", "", undefined, "/signup", "//evil.com"])).toEqual([
      "/login",
      "/signup",
    ]);
  });
});

describe("billing states, PRD 11.3", () => {
  const future = Math.floor(Date.now() / 1000) + 86_400;
  const past = Math.floor(Date.now() / 1000) - 60;

  it("keeps a past_due member in through the grace window, and out after it", async () => {
    const inGrace = boot("/dashboard", { answers: [signedIn({ ...FREE_MEMBER, status: "past_due", gracePeriodEndsAt: future } as never)] });
    await flush();
    expect(inGrace.location.replace).not.toHaveBeenCalled();

    const lapsed = boot("/dashboard", { answers: [signedIn({ ...FREE_MEMBER, status: "past_due", gracePeriodEndsAt: past } as never)] });
    await flush();
    // Still signed in, so not the sign in form; the dashboard is the locked page itself.
    expect(lapsed.location.replace).toHaveBeenCalledWith("/");
  });

  it("keeps a canceled member in until the period they paid for ends", async () => {
    const paidUp = boot("/dashboard", { answers: [signedIn({ ...FREE_MEMBER, status: "canceled", currentPeriodEnd: future } as never)] });
    await flush();
    expect(paidUp.location.replace).not.toHaveBeenCalled();

    const over = boot("/dashboard", { answers: [signedIn({ ...FREE_MEMBER, status: "canceled", currentPeriodEnd: past } as never)] });
    await flush();
    expect(over.location.replace).toHaveBeenCalledWith("/");
  });
});

describe("section locks", () => {
  const SECTIONS: SectionLockRule[] = [
    { name: "VIP article", enabled: true, audience: "members", requiredTier: "vip", lockedAction: "hide" },
    { name: "Upgrade teaser", enabled: true, audience: "others", requiredTier: "vip", lockedAction: "hide" },
    { name: "Member preview", enabled: true, audience: "members", requiredTier: "signed_in", lockedAction: "blur" },
  ];

  /** Every way a layer can be tagged with a rule: name, override attribute, override class. */
  const sel = (name: string, slug: string) =>
    `[data-framer-name="Lock: ${name}" i],[data-framer-name="Lock:${name}" i],[data-mf-lock="${name}" i],.mf-lock-${slug}`;
  const VIP = sel("VIP article", "vip-article");
  const TEASER = sel("Upgrade teaser", "upgrade-teaser");
  const PREVIEW = sel("Member preview", "member-preview");

  const BASE = ['[data-framer-name^="Lock:" i]', "[data-mf-lock]", '[class*="mf-lock-"]'];
  /** The exempt list inside the hide rule: the layers that are shown or blurred. */
  const exempt = (css: string) => css.slice(css.indexOf(":not(") + 5, css.indexOf(")" + "," + BASE[1]));

  it("hides every tagged layer, however it was tagged, before the session is known", () => {
    const shield = boot("/about", { answers: ["pending"], sectionRules: SECTIONS });
    expect(shield.sectionCss()).toBe(`${BASE.join(",")}{display:none !important}`);
  });

  it("shows each layer only to the people its own rule names", async () => {
    const shield = boot("/about", { answers: [signedIn()], sectionRules: SECTIONS });
    await flush();
    const shown = exempt(shield.sectionCss());

    // A Free member: no VIP article, the upgrade teaser instead, the preview unblurred.
    expect(shown).not.toContain(VIP);
    expect(shown).toContain(TEASER);
    expect(shown).toContain(PREVIEW);
    expect(shield.sectionCss()).not.toContain("blur(");
  });

  it("reverses for a member with the plan", async () => {
    const shield = boot("/about", { answers: [signedIn({ ...FREE_MEMBER, activeTier: "vip" })], sectionRules: SECTIONS });
    await flush();
    const shown = exempt(shield.sectionCss());

    expect(shown).toContain(VIP);
    expect(shown).not.toContain(TEASER);
  });

  it("blurs instead of hiding when the rule says blur", async () => {
    const shield = boot("/about", { answers: [signedOut], sectionRules: SECTIONS });
    await flush();
    const css = shield.sectionCss();

    expect(exempt(css)).toContain(PREVIEW);
    expect(css).toContain(`${PREVIEW}{filter:blur(10px)`);
  });

  it("keeps members' layers hidden and shows the way in when the API is down", async () => {
    const shield = boot("/about", { answers: ["network_error"], sectionRules: SECTIONS });
    await flush();
    const shown = exempt(shield.sectionCss());

    expect(shown).not.toContain(VIP);
    expect(shown).toContain(TEASER);
  });

  it("uses a cached session with no request", () => {
    const cached = JSON.stringify({ ts: Date.now(), session: { ...FREE_MEMBER, activeTier: "vip" }, tiers: TIERS });
    const shield = boot("/about", { session: { [CACHE_KEY]: cached }, sectionRules: SECTIONS });

    expect(shield.fetch).not.toHaveBeenCalled();
    expect(exempt(shield.sectionCss())).toContain(VIP);
  });

  it("re-checks when a component signs the member in or out", async () => {
    const shield = boot("/about", {
      answers: [signedOut, signedIn({ ...FREE_MEMBER, activeTier: "vip" })],
      sectionRules: SECTIONS,
    });
    await flush();
    expect(exempt(shield.sectionCss())).not.toContain(VIP);

    shield.emit("memberframe:session-updated", { detail: { signedIn: true } });
    await flush();
    expect(exempt(shield.sectionCss())).toContain(VIP);
  });

  it("treats a switched-off rule as a lock that is off: its layers show, with no request", () => {
    const shield = boot("/about", { answers: ["pending"], sectionRules: [{ ...SECTIONS[0]!, enabled: false }] });

    expect(shield.fetch).not.toHaveBeenCalled();
    expect(exempt(shield.sectionCss())).toContain(VIP);
  });
});

describe("section gates: the card over a blurred members' section", () => {
  type FakeEl = {
    tag: string;
    id: string;
    className: string;
    textContent: string;
    href?: string;
    attrs: Record<string, string>;
    children: FakeEl[];
    parentNode: FakeEl | null;
    listeners: Record<string, Array<() => void>>;
    setAttribute(name: string, value: string): void;
    appendChild(child: FakeEl): void;
    removeChild(child: FakeEl): void;
    addEventListener(type: string, fn: () => void): void;
  };
  const el = (tag: string): FakeEl => ({
    tag,
    id: "",
    className: "",
    textContent: "",
    attrs: {},
    children: [],
    parentNode: null,
    listeners: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parentNode = null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
  });

  function run(answer: { status: number; body: unknown }) {
    const head = el("head");
    const body = el("body");
    const section = { getBoundingClientRect: () => ({ top: 100, left: 20, width: 600, height: 300 }) };
    const session = memoryStorage();
    const window = {
      location: { pathname: "/about", search: "", hash: "", origin: ORIGIN, href: `${ORIGIN}/about`, replace: vi.fn(), reload: vi.fn() },
      history: { pushState: vi.fn(), replaceState: vi.fn() },
      localStorage: memoryStorage(),
      sessionStorage: session,
      addEventListener: vi.fn(),
      requestAnimationFrame: (fn: () => void) => {
        fn();
        return 1;
      },
      pageXOffset: 0,
      pageYOffset: 50,
      innerHeight: 800,
    };
    const document = {
      head,
      body,
      documentElement: head,
      createElement: (tag: string) => el(tag),
      addEventListener: vi.fn(),
      querySelectorAll: (selector: string) => (selector.includes(".mf-lock-about-content") ? [section] : []),
    };
    const fetch = vi.fn(() => Promise.resolve({ status: answer.status, ok: answer.status < 300, json: () => Promise.resolve(answer.body) }));
    const js = generateShieldJs({
      siteKey: SITE_KEY,
      apiBase: "https://api.test",
      loginPath: "/login",
      pricingPath: "/pricing",
      rules: [],
      tiers: [...TIERS, { key: "standard", rank: 1, name: "Standard" }],
      sectionRules: [{ name: "About Content", enabled: true, audience: "members", requiredTier: "standard", lockedAction: "blur" }],
    });
    new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "URL", js)(window, document, fetch, () => 0, () => undefined, URL);
    const card = () => body.children[0]?.children[0];
    return { body, session, card };
  }

  const text = (node: FakeEl | undefined) => (node ? node.children.map((child) => child.textContent) : []);

  it("asks a visitor to sign in, over the section's box, and remembers the page", async () => {
    const shield = run({ status: 401, body: {} });
    await flush();
    const gate = shield.body.children[0]!;
    expect(gate.attrs["style"]).toBe("top:150px;left:20px;width:600px;height:300px");
    expect(text(shield.card())).toEqual(["Members only", "Sign in to see this.", "Sign in"]);
    const link = shield.card()!.children[2]!;
    expect(link.href).toBe("/login");
    link.listeners["click"]![0]!();
    expect(JSON.parse(shield.session.getItem(`memberframe:return-to:${SITE_KEY}`)!).path).toBe("/about");
  });

  it("offers a member on a lower plan the plans, naming the tier", async () => {
    const shield = run({ status: 200, body: { member: FREE_MEMBER, tiers: [...TIERS, { key: "standard", rank: 1, name: "Standard" }] } });
    await flush();
    expect(text(shield.card())).toEqual(["Standard members only", "Upgrade your plan to see this.", "See plans"]);
    expect(shield.card()!.children[2]!.href).toBe("/pricing");
  });
});

describe("the reset page is a sign-in page, except with a reset token (2026-10-22)", () => {
  const js = generateShieldJs({
    siteKey: SITE_KEY,
    apiBase: "https://api.test",
    loginPath: "/login",
    guestPaths: shieldGuestPaths(["/login", "/signup", "/reset-password"]),
    resetPath: "/reset-password",
    rules: [],
    tiers: TIERS,
  });

  it("lists the reset page among the pages a signed-in member is moved off", () => {
    expect(js).toContain('var GUEST_PATHS = ["/login","/signup","/reset-password"];');
    expect(js).toContain('var RESET_PATH = "/reset-password";');
  });

  it("leaves a reset link alone, signed in or not", () => {
    expect(js).toContain('if (path === RESET_PATH && /[?&]token=/.test(window.location.search || "")) return false;');
  });
});
