import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

// A18: no gradient backdrop, and glass/blur only on the sidebar. jsdom cannot
// paint Tailwind classes, so this guards the rendered class vocabulary at source.
const SRC = resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

// The HTML entry pages (main window, splash screen) paint before React does
const ENTRY_PAGES = ["index.html", "splashscreen.html"].map((name) => resolve(SRC, "..", name));

const files = [...sourceFiles(SRC), ...ENTRY_PAGES].map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf-8"),
}));

describe("theme guard", () => {
  it("has no animated gradient blobs or gradient backdrops", () => {
    const offenders = files
      .filter(({ text }) => /animated-bg|className="blob"|linear-gradient|radial-gradient/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("applies glass/blur only to the sidebar and the window frame it sits on", () => {
    const allowed = ["styles/globals.css", "components/layout/Sidebar.tsx", "components/layout/AppFrame.tsx"];
    const offenders = files
      .filter(({ path }) => !allowed.includes(path))
      .filter(({ text }) => /glass-|backdrop-blur|backdrop-filter/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
