import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");

describe("bundled Inter font", () => {
  it("loads Inter Variable from the fontsource package as the app font", () => {
    const css = readFileSync(resolve(root, "src/styles/globals.css"), "utf8");
    expect(css).toContain('@import "@fontsource-variable/inter/wght.css";');
    expect(css).toMatch(/--font-sans:\s*"Inter Variable"/);
  });

  it("ships the SIL Open Font License next to the app", () => {
    const licence = readFileSync(resolve(root, "public/fonts/Inter-OFL-LICENSE.txt"), "utf8");
    expect(licence).toContain("SIL Open Font License, Version 1.1");
    expect(licence).toContain("The Inter Project Authors");
  });
});
