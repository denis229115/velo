import { render, screen, fireEvent } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import { TicketInspector } from "./TicketInspector";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
vi.mock("./useFreshdeskWritable", () => ({
  useFreshdeskWritable: () => ({ writable: true, controlProps: {} }),
  FreshdeskWriteReason: () => null,
}));
vi.mock("@/services/freshdesk/connection", () => ({
  getHelpdeskConnection: async () => ({ tenantId: "tenant" }),
  getHelpdeskMetadataSummary: async () => ({ agents: [], groups: [] }),
}));
vi.mock("@/services/db/freshdesk", () => ({
  getTicketFields: async () => [
    { name: "cf_count", label: "Count", type: "custom_number", isDefault: false },
    { name: "cf_checked", label: "Checked", type: "custom_checkbox", isDefault: false },
  ],
  getFieldChoices: async () => [],
}));
const ticket = { id: "1", subject: "Test", status: { label: "Open" }, tags: [], dueBy: null, customFields: { cf_count: 3, cf_checked: true } } as unknown as TicketListItem;
it("edits zero and unchecked as typed scalars, and clears a number with null", async () => {
  const onEdit = vi.fn();
  render(<TicketInspector ticket={ticket} onEdit={onEdit} />);
  // Field metadata loads asynchronously; give it room when the whole suite is busy.
  const count = await screen.findByLabelText("Count", {}, { timeout: 5000 });
  const checked = await screen.findByRole("checkbox", { name: "Checked" }, { timeout: 5000 });
  fireEvent.change(count, { target: { value: "0" } }); fireEvent.blur(count);
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ changes: { customFields: { cf_count: 0 } } }));
  fireEvent.click(checked);
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ changes: { customFields: { cf_checked: false } } }));
  fireEvent.change(count, { target: { value: "" } }); fireEvent.blur(count);
  expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ changes: { customFields: { cf_count: null } } }));
});
