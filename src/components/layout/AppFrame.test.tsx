import { render, screen } from "@testing-library/react";
import { AppFrame } from "./AppFrame";
import { declaredStyle, injectThemeCss, parseColor, readToken } from "@/test/themeTestUtils";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

function renderFrame(isMac: boolean, sidebarCollapsed = false) {
  return render(
    <AppFrame
      isMac={isMac}
      sidebarCollapsed={sidebarCollapsed}
      sidebar={<aside aria-label="Sidebar">nav</aside>}
      footer={<footer>status</footer>}
    >
      <div>mail list</div>
    </AppFrame>,
  );
}

describe("AppFrame", () => {
  beforeAll(() => injectThemeCss());

  describe.each(["light", "dark"] as const)("in the %s theme", (theme) => {
    beforeEach(() => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    it("draws the window frame in the translucent sidebar colour, with the sidebar sitting on it", () => {
      const { container } = renderFrame(true);
      const frame = container.firstElementChild as HTMLElement;
      expect(getComputedStyle(frame).backgroundColor).toBe("var(--surface-sidebar)");
      expect(frame).toHaveClass("glass-sidebar");
      expect(parseColor(readToken("surface-sidebar")).a).toBeLessThan(1);
      expect(frame).toContainElement(screen.getByRole("complementary", { name: "Sidebar" }));
      expect(screen.getByRole("main")).not.toContainElement(screen.getByRole("complementary", { name: "Sidebar" }));
    });

    it("insets the content in a solid rounded panel with a hairline border and a soft shadow", () => {
      renderFrame(true);
      const panel = getComputedStyle(screen.getByRole("main"));
      expect(panel.backgroundColor).toBe("var(--surface-list)");
      expect(parseColor(readToken("surface-list")).a).toBe(1);
      expect(panel.borderRadius).toBe("var(--panel-radius)");
      expect(readToken("panel-radius")).toBe("10px");
      expect(panel.borderTopWidth).toBe("1px");
      expect(declaredStyle(screen.getByRole("main"), "border-color")).toBe("var(--panel-border)");
      expect(parseColor(readToken("panel-border")).a).toBeLessThan(0.2);
      expect(panel.boxShadow).toBe("var(--panel-shadow)");
    });

    it("leaves a small frame gap on the top, right and bottom of the panel", () => {
      renderFrame(true);
      const panel = screen.getByRole("main");
      expect(readToken("frame-gap")).toBe("8px");
      expect(declaredStyle(panel, "margin-right")).toBe("var(--frame-gap)");
      expect(declaredStyle(panel, "margin-bottom")).toBe("var(--frame-gap)");
      expect(declaredStyle(panel, "margin-top")).toBe("var(--frame-gap)");
      expect(declaredStyle(panel, "margin-left")).toBe("0px");
    });

    it("keeps the footer inside the panel", () => {
      renderFrame(true);
      expect(screen.getByRole("main")).toHaveTextContent("mail liststatus");
    });
  });

  it("on macOS leaves a drag area for the traffic lights above the sidebar instead of a title bar", () => {
    const { container } = renderFrame(true);
    expect(screen.queryByText("Velo")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-tauri-drag-region]").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTitle("Minimize")).not.toBeInTheDocument();
  });

  it("on macOS keeps the traffic lights off the panel when the sidebar is collapsed", () => {
    renderFrame(true, true);
    expect(declaredStyle(screen.getByRole("main"), "margin-top")).toBe("var(--titlebar-height)");
  });

  it("on Windows and Linux keeps the title bar with window controls on the frame", () => {
    renderFrame(false);
    expect(screen.getByTitle("Minimize")).toBeInTheDocument();
    expect(screen.getByTitle("Close")).toBeInTheDocument();
    expect(declaredStyle(screen.getByRole("main"), "margin-top")).toBe("0px");
  });
});
