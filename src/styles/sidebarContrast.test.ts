import themeCss from "./theme.css?raw";
import { parseColor, readToken } from "@/test/themeTestUtils";

// jsdom does not evaluate media queries. Select their active rules from the
// real CSSOM, keeping selectors and source order for the actual cascade.
function mountTheme(activeMedia: string[]) {
  const source = document.createElement("style");
  source.textContent = themeCss;
  document.head.appendChild(source);
  const css = Array.from(source.sheet!.cssRules).map((rule) => {
    if (rule instanceof CSSMediaRule) {
      return activeMedia.includes(rule.conditionText)
        ? Array.from(rule.cssRules).map((child) => child.cssText).join("\n")
        : "";
    }
    return rule.cssText;
  }).join("\n");
  source.textContent = css;
  return source;
}

let style: HTMLStyleElement;

afterEach(() => {
  style.remove();
  document.documentElement.className = "";
});

describe.each([false, true])("sidebar contrast (dark=%s)", (dark) => {
  it.each([false, true])("is opaque with the contrast class (native vibrancy=%s)", (native) => {
    style = mountTheme([]);
    document.documentElement.className = [
      "platform-mac", "increase-contrast", dark && "dark", native && "native-vibrancy",
    ].filter(Boolean).join(" ");
    expect(readToken("surface-sidebar")).toBe(dark ? "#202020" : "#ececec");
    expect(parseColor(readToken("surface-sidebar")).a).toBe(1);

    // Returning to normal contrast restores the existing translucent sidebar.
    document.documentElement.classList.remove("increase-contrast");
    expect(parseColor(readToken("surface-sidebar")).a).toBeLessThan(1);
  });

  it.each([false, true])("is opaque at first paint before appearance classes (native vibrancy=%s)", (native) => {
    style = mountTheme(["(prefers-contrast: more)"]);
    document.documentElement.className = [
      "platform-mac", dark && "dark", native && "native-vibrancy",
    ].filter(Boolean).join(" ");
    expect(document.documentElement.classList.contains("increase-contrast")).toBe(false);
    expect(readToken("surface-sidebar")).toBe(dark ? "#202020" : "#ececec");
    expect(parseColor(readToken("surface-sidebar")).a).toBe(1);
  });

  it("keeps the dark/light fallback when both accessibility preferences apply", () => {
    style = mountTheme(["(prefers-contrast: more)", "(prefers-reduced-transparency: reduce)"]);
    document.documentElement.className = `platform-mac native-vibrancy reduce-transparency increase-contrast${dark ? " dark" : ""}`;
    expect(readToken("surface-sidebar")).toBe(dark ? "#202020" : "#ececec");
  });
});
