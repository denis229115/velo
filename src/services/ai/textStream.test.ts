import { describe, expect, it } from "vitest";
import { completeText, readTextStream } from "./textStream";

describe("completeText", () => {
  it("yields one finished chunk", async () => {
    const seen: string[] = [];
    const text = await readTextStream(completeText("Hello"), (soFar) => seen.push(soFar));
    expect(text).toBe("Hello");
    expect(seen).toEqual(["Hello"]);
  });

  it("yields nothing after abort", async () => {
    const stream = completeText("Hello");
    stream.abort();
    const text = await readTextStream(stream, () => {});
    expect(text).toBe("");
  });
});
