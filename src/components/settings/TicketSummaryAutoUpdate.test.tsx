import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const store = vi.hoisted(() => ({ value: null as string | null, writes: [] as [string, string][] }));
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => store.value),
  setSetting: vi.fn(async (key: string, value: string) => {
    store.writes.push([key, value]);
    store.value = value;
  }),
}));

import { TicketSummaryAutoUpdate } from "./TicketSummaryAutoUpdate";

beforeEach(() => {
  store.value = null;
  store.writes = [];
});

describe("Settings: Update summaries automatically", () => {
  it("is on by default", async () => {
    render(<TicketSummaryAutoUpdate />);
    expect(await screen.findByRole("switch", { name: "Update summaries automatically" })).toBeChecked();
  });

  it("turns off and on again, remembering the choice", async () => {
    render(<TicketSummaryAutoUpdate />);
    const toggle = await screen.findByRole("switch", { name: "Update summaries automatically" });

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(store.writes).toEqual([["ticket_summary_auto_update", "false"]]);

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(store.writes.at(-1)).toEqual(["ticket_summary_auto_update", "true"]);
  });

  it("shows a stored off choice", async () => {
    store.value = "false";
    render(<TicketSummaryAutoUpdate />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Update summaries automatically" })).not.toBeChecked());
  });

  it("says what it does and that it uses the same send rules", async () => {
    render(<TicketSummaryAutoUpdate />);
    expect(await screen.findByText(/new public message/i)).toBeInTheDocument();
    expect(screen.getByText(/send preview/i)).toBeInTheDocument();
  });
});
