import { describe, it, expect, beforeEach } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { useTicketStore } from "@/stores/ticketStore";
import { useUIStore } from "@/stores/uiStore";
import type { TicketListData, TicketSyncStatus } from "@/services/freshdesk/ticketSync";
import { FreshdeskWriteReason, useFreshdeskWritable } from "./useFreshdeskWritable";

function listData(state: TicketSyncStatus["state"], isSample = false): TicketListData {
  return {
    isSample,
    meAgentId: null,
    tickets: [],
    sync: {
      state,
      lastSuccessAt: null,
      stale: false,
      retryAt: null,
      message: null,
      coverage: { complete: false, outstandingTotal: null, outstandingDownloaded: null },
    },
  };
}

beforeEach(() => {
  useTicketStore.setState(useTicketStore.getInitialState(), true);
  useUIStore.setState({ isOnline: true });
});

describe("useFreshdeskWritable", () => {
  it("allows writes while online and the helpdesk answers", () => {
    useTicketStore.setState({ data: listData("ok") });
    const { result } = renderHook(() => useFreshdeskWritable());
    expect(result.current.writable).toBe(true);
    expect(result.current.reason).toBeNull();
    expect(result.current.controlProps).toEqual({ disabled: false });
  });

  it("offline, disables writes with the reason and re-enables them on reconnect without a reload", () => {
    useTicketStore.setState({ data: listData("ok") });
    const { result } = renderHook(() => useFreshdeskWritable());

    act(() => useUIStore.setState({ isOnline: false }));
    expect(result.current.writable).toBe(false);
    expect(result.current.reason).toBe("Needs a connection to Freshdesk");
    expect(result.current.controlProps).toMatchObject({
      disabled: true,
      title: "Needs a connection to Freshdesk",
      "aria-describedby": result.current.reasonId,
    });

    act(() => useUIStore.setState({ isOnline: true }));
    expect(result.current.writable).toBe(true);
    expect(result.current.controlProps).toEqual({ disabled: false });
  });

  it.each(["error", "auth_error"] as const)("disables writes while the helpdesk connection is known unavailable (%s)", (state) => {
    useTicketStore.setState({ data: listData(state) });
    const { result } = renderHook(() => useFreshdeskWritable());
    expect(result.current.writable).toBe(false);
    expect(result.current.reason).toBe("Needs a connection to Freshdesk");
  });

  it("explains sample data on its own, whatever the connection", () => {
    useTicketStore.setState({ data: listData("sample", true) });
    const { result } = renderHook(() => useFreshdeskWritable());
    expect(result.current.writable).toBe(false);
    expect(result.current.reason).toBe("Sample tickets can't be changed. Connect a helpdesk to change tickets.");
  });

  it("shows the reason as a status the controls point at, and nothing when writes are allowed", () => {
    useTicketStore.setState({ data: listData("ok") });
    function Probe() {
      const w = useFreshdeskWritable();
      return (
        <>
          <button {...w.controlProps}>Change</button>
          <FreshdeskWriteReason writable={w} />
        </>
      );
    }
    render(<Probe />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() => useUIStore.setState({ isOnline: false }));
    const button = screen.getByRole("button", { name: "Change" });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Needs a connection to Freshdesk");
    expect(button).toHaveAccessibleDescription("Needs a connection to Freshdesk");
  });
});
