/**
 * Served under a path (https://app.framefic.com/memberframe), the hosted
 * account page must link, post, and redirect under that path too, or the
 * browser asks the domain's root, where the proxy has nothing (503).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", async (original) => {
  const real = (await original()) as { env: Record<string, unknown> };
  return { env: { ...real.env, apiBaseUrl: "https://app.framefic.com/memberframe" } };
});

const { basePath } = await import("../src/lib/publicApiBase.js");
const { renderCreatorAuthPage, renderAuthSuccessPage, renderMockGooglePage } = await import("../src/lib/creatorAuthPageHtml.js");

describe("the hosted page under a path", () => {
  it("reads the path from API_BASE_URL", () => {
    expect(basePath()).toBe("/memberframe");
  });

  it("puts every icon, link, post, and redirect under it", () => {
    const page = renderCreatorAuthPage({ mode: "register", sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", theme: "light", googleEnabled: true, error: "" });
    expect(page).toContain('src="/memberframe/assets/memberframe-icon.svg"');
    expect(page).toContain('href="/memberframe/api/account/google?sessionId=');
    expect(page).toContain('"base":"/memberframe"');
    expect(page).toContain('post(CONFIG.base + "/api/account/code"');
    expect(page).not.toMatch(/post\("\/api\//);
    expect(page).not.toContain('src="/assets/');

    expect(renderAuthSuccessPage({ theme: "dark", trial: true })).toContain('src="/memberframe/assets/memberframe-icon.svg"');
    expect(renderMockGooglePage({ sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", theme: "dark" })).toContain(
      'action="/memberframe/api/account/google/mock"'
    );
  });
});
