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

  it("keeps the working phase when a stopped run settles after a newer run started", async () => {
    const { result } = renderHook(() => useAiStream());
    let releaseOld: (value: string) => void = () => {};
    const oldPending = new Promise<string>((resolve) => { releaseOld = resolve; });
    let first: Promise<string | null> = Promise.resolve(null);
    act(() => {
      first = result.current.run(async function* () { yield await oldPending; });
    });
    act(() => { result.current.stop(); });
    let releaseNew: (value: string) => void = () => {};
    const newPending = new Promise<string>((resolve) => { releaseNew = resolve; });
    let second: Promise<string | null> = Promise.resolve(null);
    act(() => {
      second = result.current.run(async function* () { yield await newPending; });
    });
    expect(result.current.phase).toBe("working");
    releaseOld("late");
    await act(async () => { await first; });
    expect(result.current.phase).toBe("working");
    releaseNew("done");
    await act(async () => { await second; });
    expect(await second).toBe("done");
  });
});
