/**
 * FP-07, FP-10, FP-12: the parts that decide who reads, saves, and downloads.
 *
 * The meter's rule, because a wrong count either gives articles away or locks
 * a reader out early. Download links, because a link that outlives its minute
 * or survives an edit is a shared file. The S3 signature, against AWS's own
 * published example. And the guards on anything a creator or member types
 * that the server later fetches or renders as a link.
 */

import { describe, expect, it } from "vitest";

const { presignS3 } = await import("../src/services/assets/s3Presign.js");
const { createLinkToken, readLinkToken } = await import("../src/services/assets/downloadLink.js");
const { checkRemoteUrlShape, isPrivateAddress } = await import("../src/services/assets/remoteUrl.js");
const { ASSET_ID_PATTERN, directDownloadUrl, mimeFor, newAssetId, safeFileName } = await import(
  "../src/services/assets/assetService.js"
);
const { decideMeter, MAX_METERED_SLUGS } = await import("../src/services/meterService.js");
const { ITEM_SLUG_PATTERN, safeBookmarkUrl } = await import("../src/services/bookmarkService.js");

describe("S3 presigning", () => {
  it("matches AWS's published query-string example", () => {
    const url = presignS3(
      {
        endpoint: "https://s3.amazonaws.com",
        bucket: "examplebucket",
        region: "us-east-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      { method: "GET", key: "test.txt", expiresSeconds: 86400, now: new Date("2013-05-24T00:00:00Z") }
    );
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("puts the bucket in the path for R2 and other non-AWS endpoints", () => {
    const url = presignS3(
      { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "files", region: "auto", accessKeyId: "a", secretAccessKey: "b" },
      { method: "PUT", key: "assets/site/abc", expiresSeconds: 60 }
    );
    expect(url.startsWith("https://acct.r2.cloudflarestorage.com/files/assets/site/abc?")).toBe(true);
    expect(url).toContain("X-Amz-Expires=60");
  });
});

describe("download links", () => {
  const claims = { assetId: "ast_abc", siteId: "site-1", memberId: "member-1", expiresAt: 1_000_060 };

  it("reads back what it signed while in time", () => {
    const token = createLinkToken(claims, "secret");
    expect(readLinkToken(token, 1_000_000, "secret")).toEqual({ ok: true, claims });
  });

  it("is refused one second after it expires (PRD F10: replay after 61 seconds)", () => {
    const token = createLinkToken(claims, "secret");
    expect(readLinkToken(token, 1_000_060, "secret").ok).toBe(true);
    expect(readLinkToken(token, 1_000_061, "secret")).toEqual({ ok: false, reason: "link_expired" });
  });

  it("is refused when its expiry is edited", () => {
    const token = createLinkToken(claims, "secret");
    const [, signature] = token.split(".");
    const extended = Buffer.from(JSON.stringify({ a: "ast_abc", s: "site-1", m: "member-1", e: 9_999_999_999 })).toString("base64url");
    expect(readLinkToken(`${extended}.${signature}`, 1_000_000, "secret")).toEqual({ ok: false, reason: "invalid_link" });
  });

  it("is refused under another secret, and when malformed", () => {
    const token = createLinkToken(claims, "secret");
    expect(readLinkToken(token, 1_000_000, "other").ok).toBe(false);
    expect(readLinkToken("nonsense", 1_000_000, "secret").ok).toBe(false);
    expect(readLinkToken(`${token}.x`, 1_000_000, "secret").ok).toBe(false);
  });

  it("names no storage detail", () => {
    const payload = Buffer.from(createLinkToken(claims, "secret").split(".")[0] ?? "", "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual(["a", "e", "m", "s"]);
  });
});

describe("linked files", () => {
  it("knows private and reserved addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("accepts only public https links", () => {
    expect(checkRemoteUrlShape("https://cdn.example.com/a.zip")).toBe("https://cdn.example.com/a.zip");
    expect(() => checkRemoteUrlShape("http://cdn.example.com/a.zip")).toThrow();
    expect(() => checkRemoteUrlShape("https://localhost/a.zip")).toThrow();
    expect(() => checkRemoteUrlShape("https://169.254.169.254/latest")).toThrow();
    expect(() => checkRemoteUrlShape("https://user:pass@example.com/a")).toThrow();
    expect(() => checkRemoteUrlShape("file:///etc/passwd")).toThrow();
  });

  it("turns Drive and Dropbox share links into the file", () => {
    expect(directDownloadUrl("https://drive.google.com/file/d/1AbC_dE-f/view?usp=sharing")).toBe(
      "https://drive.google.com/uc?export=download&id=1AbC_dE-f"
    );
    expect(directDownloadUrl("https://www.dropbox.com/s/xyz/kit.zip?dl=0")).toBe("https://www.dropbox.com/s/xyz/kit.zip?dl=1");
    expect(directDownloadUrl("https://cdn.example.com/kit.zip")).toBe("https://cdn.example.com/kit.zip");
  });
});

describe("asset identity and names", () => {
  it("makes opaque ids of the documented shape", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAssetId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(ASSET_ID_PATTERN.test(id)).toBe(true);
  });

  it("keeps a saved file name to a name", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\kit v2.zip")).toBe("kit v2.zip");
    expect(safeFileName('bad"name<>.zip')).toBe("badname.zip");
    expect(safeFileName("..")).toBe("download");
    expect(safeFileName("")).toBe("download");
  });

  it("types a file from its extension when the upload did not say", () => {
    expect(mimeFor("kit.zip", "application/octet-stream")).toBe("application/zip");
    expect(mimeFor("guide.pdf", null)).toBe("application/pdf");
    expect(mimeFor("x.bin", "image/png")).toBe("image/png");
    expect(mimeFor("x.unknown")).toBe("application/octet-stream");
  });
});

describe("the reading meter", () => {
  const DAY = 86_400_000;
  const start = 1_700_000_000_000;

  function read(state: Parameters<typeof decideMeter>[0], slug: string, now = start, limit = 3) {
    return decideMeter(state, slug, limit, 30, now);
  }

  it("counts new articles up to the limit, then refuses", () => {
    let state = read(null, "a").state;
    const second = read(state, "b");
    expect(second.answer).toMatchObject({ allowed: true, position: 2, remaining: 1 });
    state = read(second.state, "c").state;
    const fourth = read(state, "d");
    expect(fourth.answer).toMatchObject({ allowed: false, position: null, remaining: 0, count: 3 });
    expect(fourth.state.slugs).toEqual(["a", "b", "c"]);
  });

  it("does not count an article read again (PRD F07 criterion 1)", () => {
    const first = read(null, "a");
    const again = read(first.state, "a");
    expect(again.answer).toMatchObject({ allowed: true, alreadyRead: true, position: 1, remaining: 2 });
    expect(again.state.slugs).toEqual(["a"]);
  });

  it("keeps an article counted before the limit readable after the limit", () => {
    let state = read(null, "a").state;
    state = read(state, "b").state;
    state = read(state, "c").state;
    expect(read(state, "a").answer.allowed).toBe(true);
  });

  it("resets exactly at cycle start plus the window (PRD F07 criterion 2)", () => {
    let state = read(null, "a").state;
    state = read(state, "b").state;
    state = read(state, "c").state;
    expect(read(state, "d", start + 30 * DAY - 1).answer.allowed).toBe(false);
    const fresh = read(state, "d", start + 30 * DAY);
    expect(fresh.answer).toMatchObject({ allowed: true, position: 1, cycleStart: start + 30 * DAY });
  });

  it("uses a 7 day window for weekly", () => {
    const first = decideMeter(null, "a", 1, 7, start);
    expect(decideMeter(first.state, "b", 1, 7, start + 7 * DAY - 1).answer.allowed).toBe(false);
    expect(decideMeter(first.state, "b", 1, 7, start + 7 * DAY).answer.allowed).toBe(true);
  });

  it("folds in the device's reads when a member's cycle starts, so signing in gives nothing extra", () => {
    const answer = decideMeter(null, "c", 3, 30, start, ["a", "b", "a"]).answer;
    expect(answer).toMatchObject({ allowed: true, position: 3, remaining: 0 });
    expect(decideMeter(null, "d", 3, 30, start, ["a", "b", "c"]).answer.allowed).toBe(false);
  });

  it("stays bounded however many slugs it holds", () => {
    const many = Array.from({ length: 800 }, (_, index) => `s${index}`);
    const { state } = decideMeter({ slugs: many, cycleStart: start }, "x", 10, 30, start);
    expect(state.slugs.length).toBeLessThanOrEqual(MAX_METERED_SLUGS);
    expect(JSON.stringify(state).length).toBeLessThan(10_000);
  });
});

describe("bookmarks", () => {
  it("accepts a site path or a web address, never a script", () => {
    expect(safeBookmarkUrl("/templates/design-system")).toBe("/templates/design-system");
    expect(safeBookmarkUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeBookmarkUrl("javascript:alert(1)")).toBeNull();
    expect(safeBookmarkUrl("//evil.example/a")).toBeNull();
    expect(safeBookmarkUrl("data:text/html,x")).toBeNull();
    expect(safeBookmarkUrl("/a b")).toBeNull();
    expect(safeBookmarkUrl("")).toBeNull();
  });

  it("takes CMS slugs and paths as item slugs", () => {
    for (const slug of ["framer-design-system", "/blog/post-1", "lesson_3.2", "course:intro"]) {
      expect(ITEM_SLUG_PATTERN.test(slug), slug).toBe(true);
    }
    for (const slug of ["", " spaced", "<script>", "a".repeat(200)]) {
      expect(ITEM_SLUG_PATTERN.test(slug), slug).toBe(false);
    }
  });
});
