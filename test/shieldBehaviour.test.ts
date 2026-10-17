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
import type { GatedPageRule } from "../src/lib/siteSettings.js";

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
  };

  const go = (url: string) => {
    location.pathname = new URL(url, ORIGIN).pathname;
  };

  const window = {
    location,
    history: {
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
    fireTimers: () => {
      for (const fn of timers.splice(0)) fn?.();
    },
    click: (href: string) => {
      const anchor = { nodeName: "A", href, target: "", hasAttribute: () => false, parentNode: null };
      for (const fn of docListeners["click"] ?? []) {
        fn({ defaultPrevented: false, button: 0, target: anchor });
      }
    },
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

describe("a public page", () => {
  it("is left alone, with no request", () => {
    const shield = boot("/about");

    expect(shield.hidden()).toBe(false);
    expect(shield.fetch).not.toHaveBeenCalled();
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
    expect(lapsed.location.replace).toHaveBeenCalledWith("/login");
  });

  it("keeps a canceled member in until the period they paid for ends", async () => {
    const paidUp = boot("/dashboard", { answers: [signedIn({ ...FREE_MEMBER, status: "canceled", currentPeriodEnd: future } as never)] });
    await flush();
    expect(paidUp.location.replace).not.toHaveBeenCalled();

    const over = boot("/dashboard", { answers: [signedIn({ ...FREE_MEMBER, status: "canceled", currentPeriodEnd: past } as never)] });
    await flush();
    expect(over.location.replace).toHaveBeenCalledWith("/login");
  });
});
