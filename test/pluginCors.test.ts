/**
 * The plugin panel runs on a Framer origin and calls the API cross origin, so
 * every route group it uses must answer the browser's preflight with
 * Access-Control-Allow-Origin. /api/plugin once did not: the member preflight
 * answered first, and every license, seal, and billing call was blocked.
 */

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ prisma: {}, checkDatabase: async () => ({ connected: true, version: null, database: null, warnings: [], error: null }) }));

const { createApp } = await import("../src/app.js");

let base = "";
let close: () => void = () => undefined;

beforeAll(async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

describe("CORS for the plugin panel", () => {
  it.each(["/api/plugin/license?siteId=x", "/api/plugin/instance-seal", "/api/plugin/start-trial", "/api/connect/session", "/api/site/members?siteId=x", "/api/license?site=x"])(
    "answers the preflight for %s",
    async (path) => {
      const response = await fetch(base + path, {
        method: "OPTIONS",
        headers: { Origin: "https://framer.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
      });
      expect(response.status).toBeLessThan(300);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  );
});
