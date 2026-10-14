import { act, render } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import { setSetting } from "@/services/db/settings";
import { useAppearance } from "./useAppearance";
import {
  contrastRatio,
  injectThemeCss,
  mockSystemPreferences,
  readToken,
  relativeLuminance,
} from "@/test/themeTestUtils";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

function AppearanceRoot() {
  useAppearance();
  return null;
}

const isDarkScreen = () =>
  document.documentElement.classList.contains("dark") &&
  relativeLuminance(readToken("surface-reader")) < 0.05;

const isLightScreen = () =>
  !document.documentElement.classList.contains("dark") &&
  relativeLuminance(readToken("surface-reader")) > 0.85;

describe("useAppearance", () => {
  beforeAll(() => {
    // Stands in for Tailwind utilities: they sit in a cascade layer, so the
    // unlayered theme stylesheet wins. jsdom orders by insertion, so add them first.
    const utilities = document.createElement("style");
    utilities.textContent = ".animate-spin { animation: spin 1s linear infinite; transition-duration: 300ms; }";
    document.head.appendChild(utilities);
    injectThemeCss();
  });

  beforeEach(() => {
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    useUIStore.setState({ theme: "system", colorTheme: "indigo", reduceMotion: false });
  });

  it("follows macOS appearance by default, including live changes", () => {
    const system = mockSystemPreferences({ dark: true });
    render(<AppearanceRoot />);
    expect(isDarkScreen()).toBe(true);

    act(() => system.set({ dark: false }));
    expect(isLightScreen()).toBe(true);
  });

  it("can be overridden to Light or Dark regardless of macOS", () => {
    mockSystemPreferences({ dark: true });
    useUIStore.setState({ theme: "light" });
    render(<AppearanceRoot />);
    expect(isLightScreen()).toBe(true);

    act(() => useUIStore.getState().setTheme("dark"));
    mockSystemPreferences({ dark: false });
    expect(isDarkScreen()).toBe(true);
  });

  it("persists the chosen theme so it survives a restart", () => {
    mockSystemPreferences({ dark: false });
    render(<AppearanceRoot />);
    act(() => useUIStore.getState().setTheme("dark"));
    expect(setSetting).toHaveBeenCalledWith("theme", "dark");
  });

  describe("reduced motion", () => {
    function Spinner() {
      useAppearance();
      return <div data-testid="spinner" className="animate-spin" />;
    }

    const animationOf = (el: HTMLElement) => {
      const cs = getComputedStyle(el);
      return { animation: cs.animationName || cs.animation, transition: cs.transitionDuration };
    };

    it("suppresses animations and transitions when macOS requests reduced motion", () => {
      const system = mockSystemPreferences({ reducedMotion: false });
      const { getByTestId } = render(<Spinner />);
      expect(animationOf(getByTestId("spinner")).animation).toMatch(/spin/);

      act(() => system.set({ reducedMotion: true }));
      const reduced = animationOf(getByTestId("spinner"));
      expect(reduced.animation).toBe("none");
      expect(reduced.transition).toBe("0s");
    });

    it("also honours the in-app Reduce motion setting", () => {
      mockSystemPreferences({ reducedMotion: false });
      useUIStore.setState({ reduceMotion: true });
      const { getByTestId } = render(<Spinner />);
      expect(animationOf(getByTestId("spinner")).animation).toBe("none");
    });
  });

  describe.each(["light", "dark"] as const)("%s theme tokens", (theme) => {
    beforeEach(() => {
      mockSystemPreferences({ dark: false });
      useUIStore.setState({ theme });
      render(<AppearanceRoot />);
    });

    const solidSurfaces = ["surface-base", "surface-list", "surface-reader", "surface-composer", "surface-overlay"];
    const textSurfaces = ["surface-list", "surface-reader", "surface-composer", "surface-overlay"];

    it("defines every surface, text, separator, state, link and status role", () => {
      const roles = [
        ...solidSurfaces, "surface-sidebar",
        "text-primary", "text-secondary", "text-muted",
        "separator",
        "state-hover", "state-selected", "state-focus",
        "link",
        "status-success", "status-warning", "status-error",
      ];
      for (const role of roles) expect(readToken(role), role).not.toBe("");
    });

    it("renders lists, reader, composer and overlays on solid surfaces, with only the sidebar translucent", () => {
      for (const s of solidSurfaces) expect(readToken(s), s).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)/);
      expect(readToken("surface-sidebar")).toMatch(/rgba\([^)]*,\s*0?\.\d+\)/);
    });

    it("keeps body text, links and status labels readable (WCAG AA 4.5:1)", () => {
      for (const surface of [...textSurfaces, "state-hover", "state-selected"]) {
        for (const text of ["text-primary", "text-secondary", "text-muted"]) {
          expect(contrastRatio(readToken(text), readToken(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const surface of textSurfaces) {
        for (const fg of ["link", "status-success", "status-warning", "status-error"]) {
          expect(contrastRatio(readToken(fg), readToken(surface)), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it("keeps sidebar text readable through the translucent sidebar", () => {
      const sidebarOverBase = (fg: string) =>
        contrastRatio(readToken(fg), readToken("surface-sidebar"), readToken("surface-base"));
      expect(sidebarOverBase("text-primary")).toBeGreaterThanOrEqual(7);
      expect(sidebarOverBase("text-secondary")).toBeGreaterThanOrEqual(4.5);
    });

    it("makes the focus indicator stand out from every surface (WCAG 3:1)", () => {
      for (const surface of [...solidSurfaces, "state-hover", "state-selected"]) {
        expect(contrastRatio(readToken("state-focus"), readToken(surface)), surface).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
