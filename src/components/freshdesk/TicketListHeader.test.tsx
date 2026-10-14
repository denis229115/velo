import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useTicketStore } from "@/stores/ticketStore";
import type { TicketListData } from "@/services/freshdesk/ticketSync";
import { TicketList } from "./TicketList";

function listData(isSample: boolean): TicketListData {
  return {
    isSample,
    meAgentId: null,
    tickets: [],
    sync: {
      state: isSample ? "sample" : "idle",
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
});

describe("Freshdesk list header", () => {
  it.each([
    ["with sample tickets", true],
    ["with a connected helpdesk", false],
  ])("has no search icon %s: the sidebar header holds the only one", (_mode, isSample) => {
    useTicketStore.setState({ data: listData(isSample) });
    render(<TicketList selectedTicketId={null} width={420} />);

    expect(screen.getByRole("heading", { name: "All outstanding" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });
});
