import { describe, it, expect } from "vitest";
import type { TicketListItem } from "./ticketSync";
import { searchTickets } from "./ticketSearch";

function ticket(id: string, fields: Partial<TicketListItem> = {}): TicketListItem {
  return {
    id,
    subject: `Subject ${id}`,
    customer: null,
    customerEmail: null,
    status: { id: "2", label: "Open", known: true, statusClass: "open" },
    priority: null,
    assignee: null,
    assigneeId: null,
    updatedAt: 0,
    outstanding: true,
    fetchedOnDemand: false,
    isSample: false,
    ...fields,
  };
}

const ids = (tickets: TicketListItem[]) => tickets.map((t) => t.id);

describe("searchTickets", () => {
  const tickets = [ticket("1001"), ticket("1002"), ticket("2100")];

  it("finds a ticket by its ID, with or without #", () => {
    expect(ids(searchTickets(tickets, "#1002"))).toEqual(["1002"]);
    expect(ids(searchTickets(tickets, "1002"))).toEqual(["1002"]);
    expect(ids(searchTickets(tickets, " # 2100 "))).toEqual(["2100"]);
  });

  const fields = [
    ticket("1", { subject: "Cannot sign in after reset" }),
    ticket("2", { customer: "Ada Lovelace", customerEmail: "ada@example.test" }),
    ticket("3", { status: { id: "3", label: "Pending", known: true, statusClass: "waiting" } }),
    ticket("4", { priority: { id: "4", label: "Urgent" } }),
    ticket("5", { assignee: "Grace Hopper", assigneeId: "77" }),
  ];

  it("matches subject, customer name and email, status label, priority and assignee, ignoring case", () => {
    expect(ids(searchTickets(fields, "SIGN IN"))).toEqual(["1"]);
    expect(ids(searchTickets(fields, "lovelace"))).toEqual(["2"]);
    expect(ids(searchTickets(fields, "ada@example"))).toEqual(["2"]);
    expect(ids(searchTickets(fields, "pending"))).toEqual(["3"]);
    expect(ids(searchTickets(fields, "urgent"))).toEqual(["4"]);
    expect(ids(searchTickets(fields, "grace"))).toEqual(["5"]);
  });

  it("needs every word to match somewhere on the ticket", () => {
    const both = [
      ticket("10", { subject: "Refund", status: { id: "3", label: "Pending", known: true, statusClass: "waiting" } }),
      ticket("11", { subject: "Refund" }),
    ];
    expect(ids(searchTickets(both, "refund pending"))).toEqual(["10"]);
  });

  it("finds a ticket with an unknown status by the words it is shown with", () => {
    const unknown = [ticket("12", { status: { id: "99", label: null, known: false, statusClass: null } })];
    expect(ids(searchTickets(unknown, "unknown status"))).toEqual(["12"]);
  });

  it("matches nothing for an empty query", () => {
    expect(searchTickets(fields, "  ")).toEqual([]);
  });
});
