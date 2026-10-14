import { render, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { injectThemeCss, readToken } from "@/test/themeTestUtils";
import { NATIVE_VIBRANCY_CLASS, isNativeVibrancyActive, useNativeVibrancy } from "./useNativeVibrancy";

const setTheme = vi.fn(async (_theme: string) => {});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme }),
}));

const mockInvoke = vi.mocked(invoke);

function VibrancyRoot({ isDark }: { isDark: boolean }) {
  useNativeVibrancy(isDark);
  return null;
}

const hasClass = () => document.documentElement.classList.contains(NATIVE_VIBRANCY_CLASS);
const isTranslucent = (value: string) => value === "transparent" || /rgba\([^)]*,\s*0?\.\d+\)/.test(value);
const solidSurfaces = ["surface-base", "surface-list", "surface-reader", "surface-composer", "surface-overlay"];

describe("useNativeVibrancy", () => {
  beforeAll(() => injectThemeCss());

  beforeEach(() => {
    mockInvoke.mockReset();
    setTheme.mockClear();
    document.documentElement.className = "";
  });

  it("asks the backend for the native_vibrancy_active command", async () => {
    mockInvoke.mockResolvedValue(true);
    await expect(isNativeVibrancyActive()).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("native_vibrancy_active");
  });

  it("treats a missing backend or non-boolean answer as no vibrancy", async () => {
    mockInvoke.mockRejectedValue(new Error("no tauri"));
    await expect(isNativeVibrancyActive()).resolves.toBe(false);
    mockInvoke.mockResolvedValue(undefined);
    await expect(isNativeVibrancyActive()).resolves.toBe(false);
  });

  describe("on Windows, Linux and pop-out windows (backend says no)", () => {
    beforeEach(() => mockInvoke.mockResolvedValue(false));

    it("keeps the solid frame and sidebar and leaves the window theme alone", async () => {
      render(<VibrancyRoot isDark={false} />);
      await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
      expect(hasClass()).toBe(false);
      expect(readToken("surface-window")).toBe("var(--surface-base)");
      expect(readToken("surface-sidebar")).toBe("rgba(236, 236, 236, 0.82)");
      expect(setTheme).not.toHaveBeenCalled();
    });
  });

  describe("on the macOS main window (backend applied vibrancy)", () => {
    beforeEach(() => mockInvoke.mockResolvedValue(true));

    it.each([
      ["light", false],
      ["dark", true],
    ] as const)("makes only the frame and sidebar translucent in the %s theme", async (theme, isDark) => {
      if (isDark) document.documentElement.classList.add("dark");
      render(<VibrancyRoot isDark={isDark} />);
      await waitFor(() => expect(hasClass()).toBe(true));

      expect(readToken("surface-window")).toBe("transparent");
      expect(isTranslucent(readToken("surface-sidebar"))).toBe(true);
      for (const s of solidSurfaces) expect(isTranslucent(readToken(s)), `${s} (${theme})`).toBe(false);
    });

    it("matches the native material to the app theme", async () => {
      const { rerender } = render(<VibrancyRoot isDark={false} />);
      await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("light"));
      rerender(<VibrancyRoot isDark={true} />);
      await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("dark"));
    });

    it("removes the class when the window unmounts", async () => {
      const { unmount } = render(<VibrancyRoot isDark={false} />);
      await waitFor(() => expect(hasClass()).toBe(true));
      unmount();
      expect(hasClass()).toBe(false);
    });
  });
});
