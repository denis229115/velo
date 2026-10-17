import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

// A18: no gradient backdrop, and glass/blur only on the sidebar. jsdom cannot
// paint Tailwind classes, so this guards the rendered class vocabulary at source.
// `--glass-*` custom properties are the Liquid Glass vocabulary and may live in
// the theme; a glass class or a backdrop filter outside the sidebar may not.
const SRC = resolve(__dirname, "..");

function appliesGlass(text: string): boolean {
  const withoutTokens = text.replace(/--[\w-]*glass-[\w-]*/g, "");
  return /glass-|backdrop-blur|backdrop-filter/.test(withoutTokens);
}

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

/** Walks one @keyframes rule, including nested percentage blocks. */
function keyframeBodies(css: string): string[] {
  const bodies: string[] = [];
  const start = /@keyframes\s+[\w-]+\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(css))) {
    let depth = 1;
    let index = match.index + match[0].length;
    const from = index;
    while (index < css.length && depth > 0) {
      const char = css[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    bodies.push(css.slice(from, index - 1));
  }
  return bodies;
}

describe("theme guard", () => {
  it("has no animated gradient blobs or gradient backdrops", () => {
    const offenders = files
      .filter(({ path }) => path !== "styles/aura.css")
      .filter(({ text }) => /animated-bg|className="blob"|linear-gradient|radial-gradient/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("keeps the aura motion to transform and opacity", () => {
    const css = files.find((file) => file.path === "styles/aura.css")?.text ?? "";
    const bodies = keyframeBodies(css);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/filter|blur|rotate|background-position|\bwidth\b|\bheight\b/);
    }
  });

  it("applies glass/blur only to the sidebar and the window frame it sits on", () => {
    const allowed = ["styles/globals.css", "components/layout/Sidebar.tsx", "components/layout/AppFrame.tsx"];
    const offenders = files
      .filter(({ path }) => !allowed.includes(path))
      .filter(({ text }) => appliesGlass(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
