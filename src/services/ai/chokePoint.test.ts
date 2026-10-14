import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every AI request must leave Velo through the AI gateway. These rules keep any
// other module from reaching a provider client or an AI SDK.

const SRC = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split("\\").join("/"),
  code: readFileSync(path, "utf8"),
}));

describe("AI gateway choke point", () => {
  it("finds the source tree", () => {
    expect(files.some((f) => f.path === "services/ai/gateway.ts")).toBe(true);
  });

  it("only the gateway obtains a provider client", () => {
    const offenders = files
      .filter((f) => /\bgetActiveProvider\b/.test(f.code))
      .map((f) => f.path)
      .filter((p) => p !== "services/ai/gateway.ts" && p !== "services/ai/providerManager.ts");
    expect(offenders).toEqual([]);
  });

  it("only the provider manager creates provider clients", () => {
    const offenders = files
      .filter((f) => /from\s+["'][^"']*\/providers\/\w+Provider["']/.test(f.code))
      .map((f) => f.path)
      .filter((p) => p !== "services/ai/providerManager.ts");
    expect(offenders).toEqual([]);
  });

  it("only provider clients import an AI SDK", () => {
    const offenders = files
      .filter((f) => /from\s+["'](@anthropic-ai\/sdk|openai|@google\/gen[\w-]*)["']/.test(f.code))
      .map((f) => f.path)
      .filter((p) => !p.startsWith("services/ai/providers/"));
    expect(offenders).toEqual([]);
  });
});
