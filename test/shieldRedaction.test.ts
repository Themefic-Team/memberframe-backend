/**
 * Locked sections out of the live page (2026-10-22): the Route Shield
 * scrambles a locked layer's text and strips its media in place, only once
 * React has taken the nodes over, and restores them for a member with access.
 * The functions are cut out of the generated script and run on a small tree.
 */

import { describe, expect, it } from "vitest";
import { generateShieldJs } from "../src/routes/shield.js";

const js = generateShieldJs({
  siteKey: "pk_test",
  apiBase: "https://api.test",
  rules: [],
  sectionRules: [{ name: "Premium", enabled: true, audience: "members", requiredTier: "any_paid", lockedAction: "blur" }],
} as never);

const block = js.slice(js.indexOf("  var REDACT_SKIP"), js.indexOf("  /** Every tagged layer this visitor may not see"));

type FakeNode = {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  parentNode: FakeNode | null;
  firstChild: FakeNode | null;
  nextSibling: FakeNode | null;
  attrs: Record<string, string>;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  [key: string]: unknown;
};

/** An element, React's (a fiber key on it) unless hydrated is false. */
function el(name: string, attrs: Record<string, string> = {}, children: FakeNode[] = [], hydrated = true): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    nodeName: name,
    parentNode: null,
    firstChild: null,
    nextSibling: null,
    attrs: { ...attrs },
    hasAttribute: (key) => key in node.attrs,
    getAttribute: (key) => (key in node.attrs ? node.attrs[key]! : null),
    setAttribute: (key, value) => {
      node.attrs[key] = value;
    },
  };
  if (hydrated) node["__reactFiber$abc"] = {};
  children.forEach((child, index) => {
    child.parentNode = node;
    if (index > 0) children[index - 1]!.nextSibling = child;
  });
  node.firstChild = children[0] ?? null;
  return node;
}

const text = (value: string): FakeNode =>
  ({ nodeType: 3, nodeName: "#text", nodeValue: value, parentNode: null, firstChild: null, nextSibling: null, attrs: {} }) as unknown as FakeNode;

// eslint-disable-next-line no-new-func
const api = new Function(`${block}\nreturn { scramble, redactNode, restoreNode };`)() as {
  scramble(value: string): string;
  redactNode(node: FakeNode): void;
  restoreNode(node: FakeNode): void;
};

describe("the shield takes locked content out of the live page", () => {
  it("scrambles letters and digits, keeping spaces and punctuation, so blurred text still looks like text", () => {
    const out = api.scramble("Times Square, 2024: neon!");
    expect(out).toHaveLength("Times Square, 2024: neon!".length);
    expect(out).toMatch(/^[A-Z][a-z]{4} [A-Z][a-z]{5}, \d{4}: [a-z]{4}!$/);
    expect(api.scramble("কলকাতা")).toBe("xxxxxx");
  });

  it("scrambles a locked layer's text and strips its media, then restores both", () => {
    const words = text("The secret recipe");
    const image = el("IMG", { src: "https://framerusercontent.com/images/secret.jpg", srcset: "a.jpg 1x", alt: "Recipe card" });
    const frame = el("IFRAME", { src: "https://player.example.com/secret", title: "Secret video" });
    const section = el("DIV", { "data-framer-name": "Lock: Premium" }, [el("P", {}, [words]), image, frame]);

    api.redactNode(section);
    expect(words.nodeValue).not.toBe("The secret recipe");
    expect(words.nodeValue).toHaveLength("The secret recipe".length);
    expect(image.attrs["src"]).toMatch(/^data:image\/gif;base64,/);
    expect(image.attrs["srcset"]).toBe("");
    expect(image.attrs["alt"]).toBe("");
    expect(frame.attrs["src"]).toBe("about:blank");
    expect(JSON.stringify(section.attrs) + JSON.stringify(image.attrs) + words.nodeValue).not.toMatch(/secret|recipe/i);

    // Idempotent: a second pass changes nothing.
    const once = words.nodeValue;
    api.redactNode(section);
    expect(words.nodeValue).toBe(once);

    api.restoreNode(section);
    expect(words.nodeValue).toBe("The secret recipe");
    expect(image.attrs).toMatchObject({ src: "https://framerusercontent.com/images/secret.jpg", srcset: "a.jpg 1x", alt: "Recipe card" });
    expect(frame.attrs["src"]).toBe("https://player.example.com/secret");
  });

  it("keeps new text React writes into a locked layer, scrambled, and restores that", () => {
    const words = text("First article");
    const section = el("DIV", {}, [el("P", {}, [words])]);
    api.redactNode(section);
    words.nodeValue = "Second article";
    api.redactNode(section);
    expect(words.nodeValue).not.toBe("Second article");
    api.restoreNode(section);
    expect(words.nodeValue).toBe("Second article");
  });

  it("leaves a layer React has not hydrated yet, and style text, alone", () => {
    const early = text("Not hydrated yet");
    const css = text(".a{color:red}");
    api.redactNode(el("DIV", {}, [el("P", {}, [early], false), el("STYLE", {}, [css])]));
    expect(early.nodeValue).toBe("Not hydrated yet");
    expect(css.nodeValue).toBe(".a{color:red}");
  });

  it("starts only after the check answers, and watches React's writes, not Framer's animations", () => {
    expect(js).toContain("redactActive = result !== null;");
    expect(js).toContain("attributeFilter: REDACT_ATTRS");
    expect(js).toContain("characterData: true");
    // In place, never removed from React's tree.
    const section = js.slice(js.indexOf("  var REDACT_SKIP"), js.indexOf("  function scheduleRedaction()"));
    expect(section).not.toContain("removeChild");
  });
});
