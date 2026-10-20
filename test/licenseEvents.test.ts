/**
 * The license, pushed (19-pro-lock-and-trial.md 5.1): the panel holds one
 * stream open, and every change to the license reaches it at once, so nothing
 * asks the server on a timer.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const licenseNow = vi.hoisted(() => ({ state: "trial" }));

vi.mock("../src/services/license/licenseService.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveLicense: async () => ({ state: licenseNow.state }) };
});

vi.mock("../src/config/db.js", () => ({
  prisma: { site: { findUnique: async () => null } },
  checkDatabase: async () => ({ connected: true, version: null, database: null, warnings: [], error: null }),
}));

vi.mock("../src/services/creatorAuthService.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadCreator: async (token: string | undefined) =>
      token === "good" ? { userId: "user_1", sessionId: "session_1", email: "creator@example.com", name: "Creator" } : null,
    touchCreatorSession: () => undefined,
    requireOwnedSite: async (_userId: string, siteId: string) => {
      if (siteId !== "site_1") throw Object.assign(new Error("not yours"), { status: 404 });
      return { id: "site_1", siteName: "Portfolio" };
    },
  };
});

const { createApp } = await import("../src/app.js");
const { emitLicenseChanged, listenerCount, onLicenseChanged } = await import("../src/services/license/licenseEvents.js");
const { invalidateLicense } = await import("../src/services/license/licenseService.js");
const { sseFrame } = await import("../src/routes/pluginBilling.js");

let base = "";
let close: () => void = () => undefined;

beforeAll(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.closeAllConnections();
    server.close();
  };
});
afterAll(() => close());

/** Read the stream until `count` license frames have arrived. */
async function readFrames(response: Response, count: number): Promise<unknown[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: unknown[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith("event: license")) frames.push(JSON.parse(block.split("\ndata: ")[1]!));
      end = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return frames;
}

describe("license events", () => {
  it("reach only the site that changed, and stop after unsubscribing", () => {
    const seen: string[] = [];
    const offA = onLicenseChanged("site_a", () => seen.push("a"));
    const offB = onLicenseChanged("site_b", () => seen.push("b"));
    emitLicenseChanged("site_a");
    expect(seen).toEqual(["a"]);
    emitLicenseChanged();
    expect(seen).toEqual(["a", "a", "b"]);
    offA();
    offB();
    emitLicenseChanged("site_a");
    expect(seen).toEqual(["a", "a", "b"]);
    expect(listenerCount("site_a")).toBe(0);
  });

  it("are sent by invalidateLicense, which every license change already calls", () => {
    let calls = 0;
    const off = onLicenseChanged("site_c", () => (calls += 1));
    invalidateLicense("site_c");
    off();
    expect(calls).toBe(1);
  });

  it("frames as server-sent events", () => {
    expect(sseFrame("license", { license: { state: "trial" } })).toBe('event: license\ndata: {"license":{"state":"trial"}}\n\n');
  });
});

describe("GET /api/plugin/events", () => {
  it("needs the creator's token", async () => {
    const response = await fetch(`${base}/api/plugin/events?siteId=site_1`);
    expect(response.status).toBe(401);
  });

  it("sends the license now, then again when it changes, and cleans up on close", async () => {
    const response = await fetch(`${base}/api/plugin/events?siteId=site_1`, { headers: { Authorization: "Bearer good" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const reading = readFrames(response, 2);
    // Wait for the stream to subscribe, then change the license.
    for (let tries = 0; tries < 50 && listenerCount("site_1") === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listenerCount("site_1")).toBe(1);
    // An unchanged license sends nothing; a changed one is sent at once.
    invalidateLicense("site_1");
    licenseNow.state = "expired";
    invalidateLicense("site_1");

    const frames = (await reading) as Array<{ license: { state: string } }>;
    expect(frames.map((frame) => frame.license.state)).toEqual(["trial", "expired"]);

    for (let tries = 0; tries < 50 && listenerCount("site_1") > 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listenerCount("site_1")).toBe(0);
  });
});
