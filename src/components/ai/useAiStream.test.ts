import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { completeText } from "@/services/ai/textStream";
import { useAiStream } from "./useAiStream";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAiStream", () => {
  it("follows a one-chunk stream through success and back to idle", async () => {
    const { result } = renderHook(() => useAiStream());
    await act(async () => {
      await result.current.run(() => completeText("Hi"));
    });
    expect(result.current.text).toBe("Hi");
    expect(result.current.phase).toBe("success");
    await act(async () => {
      vi.advanceTimersByTime(1400);
    });
    expect(result.current.phase).toBe("idle");
  });

  it("reports an error when the stream throws", async () => {
    const { result } = renderHook(() => useAiStream());
    await act(async () => {
      await expect(result.current.run(async function* () {
        throw new Error("nope");
      })).rejects.toThrow("nope");
    });
    expect(result.current.phase).toBe("error");
  });

  it("returns to idle when the run is stopped", async () => {
    const { result } = renderHook(() => useAiStream());
    let release: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    let run: Promise<string | null> = Promise.resolve(null);
    act(() => {
      run = result.current.run(async function* () {
        yield await pending;
      });
    });
    expect(result.current.phase).toBe("working");
    act(() => {
      result.current.stop();
    });
    release("late");
    await act(async () => {
      await run;
    });
    expect(result.current.phase).toBe("idle");
    expect(await run).toBeNull();
  });
});
