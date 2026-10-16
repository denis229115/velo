import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { injectThemeCss, readToken } from "@/test/themeTestUtils";

const root = resolve(__dirname, "../..");

/** jsdom returns custom properties unresolved, so follow var() the way a browser would. */
function token(name: string): string {
  let value = readToken(name).replace(/\s+/g, " ");
  for (let i = 0; i < 4; i++) {
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (!ref?.[1]) break;
    value = readToken(ref[1].slice(2)).replace(/\s+/g, " ");
  }
  return value;
}

describe("Liquid Glass tokens", () => {
  beforeAll(() => {
    injectThemeCss();
  });

  beforeEach(() => {
    document.documentElement.className = "";
  });

  it("keeps the macOS palette, type, radii, elevation and motion beside the current tokens", () => {
    expect(token("system-label")).toBe("#1d1d1f");
    expect(token("system-label-secondary")).toBe("#6e6e73");
    expect(token("system-label-tertiary")).toBe("#aeaeb2");
    expect(token("system-separator")).toBe("#e5e5ea");
    expect(token("system-content")).toBe("#ffffff");
    expect(token("system-list")).toBe("#fafafc");
    expect(token("system-accent")).toMatch(/#007aff|accentcolor/i);
    expect(token("system-success")).toBe("#34c759");
    expect(token("system-warning")).toBe("#ff9500");
    expect(token("system-danger")).toBe("#ff3b30");

    expect(token("glass-bar-fill")).toBe("rgba(255, 255, 255, 0.62)");
    expect(token("glass-pop-fill")).toBe("rgba(250, 250, 252, 0.78)");
    expect(token("glass-blur")).toBe("0px");

    expect(token("radius-window")).toBe("26px");
    expect(token("radius-shell")).toBe("18px");
    expect(token("radius-sidebar")).toBe("16px");
    expect(token("radius-panel")).toBe("12px");
    expect(token("radius-menu")).toBe("12px");
    expect(token("radius-menu-item")).toBe("7px");
    expect(token("radius-control")).toBe("8px");
    expect(token("radius-control-sm")).toBe("6px");
    expect(token("radius-chip")).toBe("4px");
    expect(token("radius-modal")).toBe("16px");

    expect(token("elev-0")).toBe("none");
    expect(token("elev-1")).toBe("0 1px 3px rgba(0, 0, 0, 0.08)");
    expect(token("elev-2")).toBe("0 8px 24px rgba(0, 0, 0, 0.12)");
    expect(token("elev-3")).toBe("0 20px 50px rgba(0, 0, 0, 0.2)");
    expect(token("motion-ease")).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
    expect(token("motion-fast")).toBe("160ms");
    expect(token("motion-base")).toBe("220ms");
    expect(token("motion-slow")).toBe("280ms");
    expect(token("type-15")).toBe("0.9375rem");
    expect(token("type-17")).toBe("1.0625rem");
    expect(token("font-ui")).toContain("-apple-system");
    expect(token("font-ui")).toContain("Inter Variable");

    // The app still renders on the previous semantic tokens.
    expect(token("surface-reader")).toBe("#ffffff");
    expect(token("text-primary")).toBe("#171717");
    expect(token("panel-radius")).toBe("10px");
  });

  it("uses the dark palette and about twice the shadow alpha", () => {
    document.documentElement.classList.add("dark");
    expect(token("system-label")).toBe("#f5f5f7");
    expect(token("system-label-secondary")).toBe("#98989d");
    expect(token("system-label-tertiary")).toBe("#636366");
    expect(token("system-separator")).toBe("#38383a");
    expect(token("system-content")).toBe("#1c1c1e");
    expect(token("system-list")).toBe("#161618");
    expect(token("system-accent")).toMatch(/#0a84ff|accentcolor/i);
    expect(token("system-success")).toBe("#30d158");
    expect(token("system-warning")).toBe("#ff9f0a");
    expect(token("system-danger")).toBe("#ff453a");
    expect(token("glass-bar-fill")).toBe("rgba(40, 40, 44, 0.55)");
    expect(token("glass-pop-fill")).toBe("rgba(36, 36, 40, 0.72)");
    expect(token("glass-edge")).toBe("rgba(255, 255, 255, 0.1)");
    expect(token("elev-1")).toBe("0 1px 3px rgba(0, 0, 0, 0.16)");
    expect(token("elev-2")).toBe("0 8px 24px rgba(0, 0, 0, 0.24)");
    expect(token("elev-3")).toBe("0 20px 50px rgba(0, 0, 0, 0.4)");
  });

  it("paints materials solid off macOS and translucent on macOS", () => {
    expect(token("glass-bar")).toBe("#ffffff");
    expect(token("glass-pop")).toBe("#fafafc");
    expect(token("glass-highlight")).toBe("transparent");

    document.documentElement.classList.add("platform-mac");
    expect(token("glass-bar")).toBe("rgba(255, 255, 255, 0.62)");
    expect(token("glass-pop")).toBe("rgba(250, 250, 252, 0.78)");
    expect(token("glass-side")).toBe("rgba(255, 255, 255, 0.34)");
    expect(token("glass-blur")).toBe("24px");
    expect(token("glass-pop-blur")).toBe("32px");
    expect(token("glass-saturate")).toBe("180%");
    expect(token("glass-highlight")).toBe("rgba(255, 255, 255, 0.7)");
    expect(token("glass-edge")).toBe("rgba(0, 0, 0, 0.08)");

    document.documentElement.classList.add("dark");
    expect(token("glass-bar")).toBe("rgba(40, 40, 44, 0.55)");
    expect(token("glass-pop")).toBe("rgba(36, 36, 40, 0.72)");
    expect(token("glass-highlight")).toBe("rgba(255, 255, 255, 0.12)");
    expect(token("glass-edge")).toBe("rgba(255, 255, 255, 0.1)");
  });

  it("drops back to solid materials for reduced transparency and increased contrast", () => {
    document.documentElement.classList.add("platform-mac", "reduce-transparency");
    expect(token("glass-bar")).toBe("#ffffff");
    expect(token("glass-blur")).toBe("0px");
    expect(token("glass-highlight")).toBe("transparent");
    expect(token("surface-sidebar")).toBe("#ececec");

    document.documentElement.className = "platform-mac dark increase-contrast";
    expect(token("glass-bar")).toBe("#2c2c2e");
    expect(token("glass-blur")).toBe("0px");
    expect(token("system-label")).toBe("#ffffff");
    expect(token("glass-edge")).toBe("rgba(255, 255, 255, 0.55)");
  });

  it("maps the tokens into Tailwind theme aliases without replacing the Inter font stack", () => {
    const css = readFileSync(resolve(root, "src/styles/globals.css"), "utf8");
    expect(css).toMatch(/--font-sans:\s*"Inter Variable"/);
    expect(css).toContain("--color-system-label: var(--system-label)");
    expect(css).toContain("--color-glass-bar: var(--glass-bar)");
    expect(css).toContain("--shadow-e1: var(--elev-1)");
    expect(css).toContain("--shadow-e3: var(--elev-3)");
    expect(css).toContain("--ease-glass: var(--motion-ease)");
    expect(css).toContain("--radius-window: var(--radius-window)");
    expect(css).toContain("--font-ui: var(--font-ui)");
    expect(css).toContain("--text-callout: var(--type-15)");
    expect(css).toContain("--text-headline: var(--type-17)");
  });
});
