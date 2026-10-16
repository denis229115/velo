import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { contrastRatio, injectThemeCss, readToken } from "@/test/themeTestUtils";
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  getThemeById,
} from "./themes";

describe("themes", () => {
  it("all themes have unique IDs", () => {
    const ids = COLOR_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all themes have complete light and dark color sets", () => {
    const requiredKeys = ["accent", "accentHover", "accentLight", "bgSelected", "sidebarActive"];
    for (const theme of COLOR_THEMES) {
      for (const key of requiredKeys) {
        expect(theme.light).toHaveProperty(key);
        expect(theme.light[key as keyof typeof theme.light]).toBeTruthy();
        expect(theme.dark).toHaveProperty(key);
        expect(theme.dark[key as keyof typeof theme.dark]).toBeTruthy();
      }
    }
  });

  it("DEFAULT_COLOR_THEME is a neutral blue, not indigo", () => {
    expect(DEFAULT_COLOR_THEME).toBe("blue");
    expect(getThemeById(DEFAULT_COLOR_THEME).name).toBe("Blue");
  });

  it("keeps Indigo and the other presets selectable", () => {
    const ids = COLOR_THEMES.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(["indigo", "rose", "emerald", "amber", "sky", "violet", "orange", "slate"]),
    );
    expect(getThemeById("indigo").light.accent).toBe("#4f46e5");
  });

  it("getThemeById returns correct theme", () => {
    const rose = getThemeById("rose");
    expect(rose.id).toBe("rose");
    expect(rose.name).toBe("Rose");

    const emerald = getThemeById("emerald");
    expect(emerald.id).toBe("emerald");
  });

  it("getThemeById falls back to the default accent for unknown ID", () => {
    const fallback = getThemeById("nonexistent");
    expect(fallback.id).toBe("blue");
  });

  describe.each(["light", "dark"] as const)("default accent in the %s theme", (mode) => {
    beforeAll(() => injectThemeCss());
    afterEach(() => document.documentElement.classList.remove("dark"));

    const setup = () => {
      document.documentElement.classList.toggle("dark", mode === "dark");
      const colors = getThemeById(DEFAULT_COLOR_THEME)[mode];
      const list = readToken("surface-list");
      return { colors, list, surfaces: ["surface-list", "surface-reader", "surface-overlay"].map(readToken) };
    };

    it("keeps accent text readable on every surface (WCAG AA 4.5:1)", () => {
      const { colors, surfaces } = setup();
      for (const surface of surfaces) {
        expect(contrastRatio(colors.accent, surface), surface).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("keeps text readable on a selected row (WCAG AA 4.5:1)", () => {
      const { colors, list } = setup();
      for (const fg of [colors.accent, ...["text-primary", "text-secondary", "text-muted"].map(readToken)]) {
        expect(contrastRatio(fg, colors.bgSelected, list), fg).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("keeps white button text legible on the accent fill", () => {
      const { colors } = setup();
      // Light: AA for normal text. Dark: the accent must also work as text on dark
      // surfaces, so white-on-fill is held to the 3:1 non-text/large-text level.
      expect(contrastRatio("#ffffff", colors.accent)).toBeGreaterThanOrEqual(mode === "light" ? 4.5 : 3);
    });

    it("keeps the hover fill legible against white and distinct from the accent", () => {
      const { colors } = setup();
      expect(colors.accentHover).not.toBe(colors.accent);
      expect(contrastRatio("#ffffff", colors.accentHover)).toBeGreaterThanOrEqual(mode === "light" ? 4.5 : 3);
    });
  });
});
