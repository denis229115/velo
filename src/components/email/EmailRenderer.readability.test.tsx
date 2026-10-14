import { render } from "@testing-library/react";
import { EmailRenderer } from "./EmailRenderer";
import { useUIStore } from "@/stores/uiStore";
import { contrastRatio, injectThemeCss, mockSystemPreferences, readToken } from "@/test/themeTestUtils";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/services/db/imageAllowlist", () => ({ addToAllowlist: vi.fn() }));
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/email/providerFactory", () => ({ getEmailProvider: vi.fn() }));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))?$/;

/** Colour pairs as painted inside the email iframe; a transparent body shows the reader surface. */
function paintedPairs(iframe: HTMLIFrameElement) {
  const win = iframe.contentWindow!;
  const doc = iframe.contentDocument!;
  const bodyBg = win.getComputedStyle(doc.body).backgroundColor;
  const background = TRANSPARENT.test(bodyBg) ? readToken("surface-reader") : bodyBg;
  const colorOf = (selector: string) => win.getComputedStyle(doc.querySelector(selector)!).color;
  return {
    background,
    text: colorOf("body"),
    link: colorOf("a"),
    quote: colorOf("blockquote"),
  };
}

const HTML_EMAIL = '<p>Invoice attached</p><a href="https://example.com">View</a><blockquote>Earlier reply</blockquote>';

describe("sanitized email readability", () => {
  beforeAll(() => injectThemeCss());

  describe.each(["light", "dark"] as const)("in the %s theme", (theme) => {
    beforeEach(() => {
      mockSystemPreferences({ dark: false });
      useUIStore.setState({ theme });
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    it.each([
      ["an HTML email", { html: HTML_EMAIL, text: null }],
      ["a plain-text email", { html: null, text: "Invoice attached\n\nhttps://example.com" }],
    ])("keeps %s readable", (_, body) => {
      const { container } = render(<EmailRenderer {...body} />);
      const iframe = container.querySelector("iframe")!;
      const doc = iframe.contentDocument!;
      if (body.html === null) {
        // Plain text becomes HTML; add a link and a quote to check their colours too
        doc.body.insertAdjacentHTML("beforeend", '<a href="https://example.com">View</a><blockquote>Earlier reply</blockquote>');
      }
      const painted = paintedPairs(iframe);
      expect(contrastRatio(painted.text, painted.background), "text").toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(painted.link, painted.background), "link").toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(painted.quote, painted.background), "quoted text").toBeGreaterThanOrEqual(4.5);
    });
  });
});
