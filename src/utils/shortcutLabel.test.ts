import { formatShortcut, isMacPlatform } from "./shortcutLabel";

describe("formatShortcut on macOS", () => {
  it("shows Ctrl bindings as Cmd", () => {
    expect(formatShortcut("Ctrl+Shift+L", "mac")).toBe("Cmd+Shift+L");
    expect(formatShortcut("Ctrl+Enter", "mac")).toBe("Cmd+Enter");
  });

  it("shows Alt as Option", () => {
    expect(formatShortcut("Alt+Shift+K", "mac")).toBe("Option+Shift+K");
  });

  it("shows the Electron-style CmdOrCtrl as Cmd", () => {
    expect(formatShortcut("CmdOrCtrl+Shift+M", "mac")).toBe("Cmd+Shift+M");
  });

  it("leaves bare keys and key sequences alone", () => {
    expect(formatShortcut("j", "mac")).toBe("j");
    expect(formatShortcut("Esc", "mac")).toBe("Esc");
    expect(formatShortcut("g then i", "mac")).toBe("g then i");
    expect(formatShortcut("g i", "mac")).toBe("g i");
  });

  it("keeps a lone plus key as the key", () => {
    expect(formatShortcut("Ctrl++", "mac")).toBe("Cmd++");
  });
});

describe("formatShortcut on other platforms", () => {
  it.each(["windows", "linux"] as const)("returns the binding unchanged on %s", (platform) => {
    for (const binding of ["Ctrl+Shift+L", "Alt+K", "CmdOrCtrl+Shift+M", "Cmd+K", "j", "g then i"]) {
      expect(formatShortcut(binding, platform)).toBe(binding);
    }
  });
});

describe("platform detection", () => {
  const original = navigator.userAgent;
  const setUserAgent = (ua: string) =>
    Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  afterEach(() => setUserAgent(original));

  it("detects macOS from the user agent and formats for it by default", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    expect(isMacPlatform()).toBe(true);
    expect(formatShortcut("Ctrl+Shift+E")).toBe("Cmd+Shift+E");
  });

  it("treats Windows and Linux user agents as not macOS", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    expect(isMacPlatform()).toBe(false);
    expect(formatShortcut("Ctrl+Shift+E")).toBe("Ctrl+Shift+E");
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36");
    expect(isMacPlatform()).toBe(false);
  });
});
