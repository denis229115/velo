import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { formatSyncCycleLine, logSyncCycle } from "./syncCycleLog";

describe("syncCycleLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("formats a quiet cycle as one line", () => {
    expect(
      formatSyncCycleLine({
        accountId: "a1",
        provider: "imap",
        kind: "delta",
        durationMs: 840,
        foldersChecked: 12,
        messagesFetched: 0,
        errors: [],
      }),
    ).toBe("[sync] account=a1 provider=imap kind=delta folders_checked=12 messages_fetched=0 duration_ms=840 errors=0");
  });

  it("adds the first error, flattened and truncated, on a failing cycle", () => {
    const line = formatSyncCycleLine({
      accountId: "a1",
      provider: "imap",
      kind: "delta",
      durationMs: 5,
      errors: ["INBOX: fetch\nfailed " + "x".repeat(500), "Sent: other"],
    });
    expect(line).toContain("errors=2");
    expect(line).toContain('first_error="INBOX: fetch failed xxx');
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(400);
  });

  it("sends the line to the Rust log command", () => {
    logSyncCycle({ accountId: "a1", provider: "imap", kind: "delta", durationMs: 1, errors: [] });
    expect(invoke).toHaveBeenCalledWith("log_sync_cycle", {
      line: expect.stringContaining("[sync] account=a1"),
    });
  });

  it("never throws when the log command is unavailable", () => {
    vi.mocked(invoke).mockImplementation(() => {
      throw new Error("no tauri");
    });
    expect(() =>
      logSyncCycle({ accountId: "a1", provider: "imap", kind: "delta", durationMs: 1, errors: [] }),
    ).not.toThrow();
  });
});
