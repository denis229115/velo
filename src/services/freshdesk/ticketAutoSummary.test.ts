import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AUTO_SUMMARY_DEBOUNCE_MS,
  AUTO_SUMMARY_MIN_INTERVAL_MS,
  createAutoSummaryRefresher,
  type AutoSummaryPhase,
} from "./ticketAutoSummary";

/** A run that covers the key it was asked for, like the card's refresh does */
function setup(over: { canRun?: () => boolean; run?: (key: string) => Promise<string> } = {}) {
  const latest = { key: "" };
  const run = vi.fn(over.run ?? (async () => latest.key));
  const phases: AutoSummaryPhase[] = [];
  const refresher = createAutoSummaryRefresher({
    run: async () => run(latest.key),
    canRun: over.canRun ?? (() => true),
    onPhase: (p) => phases.push(p),
  });
  const activity = (key: string) => {
    latest.key = key;
    refresher.request(key);
  };
  return { refresher, run, phases, activity };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("automatic summary refresh scheduling", () => {
  it("refreshes once after several quick messages", async () => {
    const { run, activity } = setup();
    activity("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS - 1000);
    activity("m2");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS - 1000);
    activity("m3");
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("m3");
  });

  it("does not refresh again for activity it already covered", async () => {
    const { run, refresher, activity } = setup();
    activity("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    refresher.request("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_MIN_INTERVAL_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds a second refresh until the minimum interval has passed since the first", async () => {
    const { run, activity } = setup();
    activity("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    activity("m2");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_MIN_INTERVAL_MS - 1000);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("m2");
  });

  it("refreshes again after a run when activity arrived while it ran", async () => {
    let finish: (key: string) => void = () => undefined;
    const { run, activity, refresher } = setup({ run: () => new Promise<string>((resolve) => (finish = resolve)) });
    activity("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(refresher.phase()).toBe("running");

    activity("m2");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1); // never two at once

    finish("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_MIN_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs nothing while it may not, and runs once it may again", async () => {
    let allowed = false;
    const { run, activity, refresher } = setup({ canRun: () => allowed });
    activity("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(run).not.toHaveBeenCalled();
    expect(refresher.phase()).toBe("idle");

    allowed = true;
    refresher.request("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops after a failure until the operator summarizes themselves", async () => {
    const { run, activity, refresher } = setup({
      run: async () => {
        throw new Error("provider down");
      },
    });
    activity("m1");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(refresher.phase()).toBe("idle");

    activity("m2");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_MIN_INTERVAL_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);

    refresher.reset(); // a manual summary succeeded
    activity("m3");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_MIN_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops when blocked (cancelled) and drops what was waiting", async () => {
    const { run, activity, refresher } = setup();
    activity("m1");
    refresher.block();
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_MIN_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("drops what was waiting when disposed", async () => {
    const { run, activity, refresher } = setup();
    activity("m1");
    refresher.dispose();
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_MIN_INTERVAL_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports debouncing, running and cooling phases", async () => {
    const { phases, activity, refresher } = setup();
    activity("m1");
    expect(refresher.phase()).toBe("debouncing");
    await vi.advanceTimersByTimeAsync(AUTO_SUMMARY_DEBOUNCE_MS);
    expect(phases).toEqual(["debouncing", "running", "idle"]);

    activity("m2");
    expect(refresher.phase()).toBe("cooling");
  });
});
