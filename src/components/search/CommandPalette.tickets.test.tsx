import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import { ALPHA_HOST, authenticationFailure } from "@/services/freshdesk/__fixtures__/freshdeskFixtures";
import { FIXTURE_NOW, alphaTenantWithTickets, rateLimited } from "@/services/freshdesk/__fixtures__/freshdeskTicketFixtures";

let db: SqliteTestDb;
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    })),
  },
}));
vi.mock("@/utils/crypto", () => ({
  encryptValue: vi.fn(async (v: string) => `enc:${v}`),
  decryptValue: vi.fn(async (v: string) => v.slice(4)),
  isEncrypted: vi.fn((v: string) => v.startsWith("enc:")),
}));
const ALPHA_KEY = "fixture-key-alpha-0001";
let stub: ReturnType<typeof createFreshdeskFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));
vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateToThread: vi.fn(),
  navigateToTicket: vi.fn(),
  navigateBack: vi.fn(),
  getActiveLabel: vi.fn(() => route.label),
  getSelectedThreadId: vi.fn(() => null),
}));
const route = vi.hoisted(() => ({ label: "inbox" }));
vi.mock("@/hooks/useRouteNavigation", () => ({ useActiveLabel: () => route.label }));

import { runMigrations } from "@/services/db/migrations";
import { classifyStatus, connectHelpdesk } from "@/services/freshdesk/connection";
import { syncTickets } from "@/services/freshdesk/ticketSync";
import { navigateToTicket } from "@/router/navigate";
import { CommandPalette } from "./CommandPalette";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

async function connectAndSync() {
  await connectHelpdesk({ host: ALPHA_HOST, apiKey: ALPHA_KEY });
  for (const [id, cls] of [["2", "open"], ["3", "waiting"], ["4", "done"], ["5", "done"], ["6", "open"]] as const) {
    await classifyStatus(id, cls);
  }
  await syncTickets({ trigger: "manual" });
}

function openPalette() {
  const onClose = vi.fn();
  render(<CommandPalette isOpen onClose={onClose} />);
  return onClose;
}

function typeQuery(value: string) {
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value } });
  return input;
}

const ticketsGroup = () => screen.findByRole("group", { name: "Tickets" });
const groupNames = () =>
  screen.getAllByRole("group").map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({ [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: alphaTenantWithTickets } });
  await runMigrations();
  route.label = "inbox";
  vi.mocked(navigateToTicket).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("Command palette ticket search", () => {
  it("finds a downloaded ticket by ID and opens it in the reader with Enter", async () => {
    await connectAndSync();
    route.label = "freshdesk";
    const onClose = openPalette();
    const input = typeQuery("#1002");

    const group = within(await ticketsGroup());
    const option = await group.findByRole("option", { name: /Fixture: export stuck/ });
    expect(within(option).getByText("#1002")).toBeInTheDocument();
    expect(within(option).getByText("Fixture Customer Bo")).toBeInTheDocument();
    expect(within(option).getByText("Fixture: With engineering")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigateToTicket).toHaveBeenCalledWith("1002");
    expect(onClose).toHaveBeenCalled();
  });

  it.each([
    ["plain ID", "1002"],
    ["subject", "export stuck"],
    ["customer name", "customer bo"],
    ["customer email", "bo.fixture@example"],
    ["status label", "with engineering"],
    ["assignee", "fixture colleague"],
  ])("matches a downloaded ticket by %s", async (_field, query) => {
    await connectAndSync();
    openPalette();
    typeQuery(query);

    const group = within(await ticketsGroup());
    expect(await group.findByRole("option", { name: /Fixture: export stuck/ })).toBeInTheDocument();
  });

  it("matches by priority label", async () => {
    await connectAndSync();
    openPalette();
    typeQuery("urgent");

    const group = within(await ticketsGroup());
    expect(await group.findByRole("option", { name: /Fixture: long-waiting reply/ })).toBeInTheDocument();
    expect(group.getAllByRole("option")).toHaveLength(1);
  });

  it("opens a clicked ticket in the reader", async () => {
    await connectAndSync();
    const onClose = openPalette();
    typeQuery("refund");

    fireEvent.click(await within(await ticketsGroup()).findByRole("option", { name: /Fixture: refund issued/ }));
    expect(navigateToTicket).toHaveBeenCalledWith("1004");
    expect(onClose).toHaveBeenCalled();
  });

  it("lists Tickets first on the Freshdesk page and after Threads elsewhere", async () => {
    await connectAndSync();
    openPalette();
    typeQuery("fixture");
    await ticketsGroup();
    expect(groupNames()).toEqual(["Threads", "Tickets"]);

    route.label = "freshdesk";
    typeQuery("fixtures");
    typeQuery("fixture");
    await waitFor(() => expect(groupNames()).toEqual(["Tickets", "Threads"]));
  });

  it("says it searched the downloaded tickets only, and reads no network while searching", async () => {
    await connectAndSync();
    const before = stub.requests.length;
    openPalette();
    typeQuery("no such words anywhere");

    const group = within(await ticketsGroup());
    expect(group.getByText("Searched downloaded tickets only (all outstanding + 90 days of done)")).toBeInTheDocument();
    expect(group.queryAllByRole("option")).toHaveLength(0);
    expect(stub.requests.length).toBe(before);
  });

  it("searches the sample tickets until a helpdesk is connected, marked Sample", async () => {
    openPalette();
    typeQuery("cannot sign in");

    const group = within(await ticketsGroup());
    const option = await group.findByRole("option", { name: /Sample ticket: cannot sign in/ });
    expect(within(option).getByText("Sample")).toBeInTheDocument();
    expect(group.getByText(/^Sample tickets only/)).toBeInTheDocument();
  });
});

describe("Command palette ticket lookup in Freshdesk", () => {
  const lookup = (id: string) => ({ name: `Look up ticket #${id} in Freshdesk` });

  it("offers the lookup for an ID that is not downloaded, and opens the ticket it finds", async () => {
    await connectAndSync();
    route.label = "freshdesk";
    const onClose = openPalette();
    const input = typeQuery("#1005");

    const group = within(await ticketsGroup());
    expect(await group.findByRole("option", lookup("1005"))).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(navigateToTicket).toHaveBeenCalledWith("1005"));
    expect(onClose).toHaveBeenCalled();
    expect(stub.requests.map((r) => new URL(r.url).pathname).at(-1)).toBe("/api/v2/tickets/1005");
  });

  it("does not offer the lookup for a downloaded ticket", async () => {
    await connectAndSync();
    openPalette();
    typeQuery("1002");

    const group = within(await ticketsGroup());
    await group.findByRole("option", { name: /Fixture: export stuck/ });
    expect(group.queryByRole("option", lookup("1002"))).not.toBeInTheDocument();
  });

  it("says when Freshdesk has no ticket with that ID", async () => {
    await connectAndSync();
    const onClose = openPalette();
    fireEvent.click(await within(await (typeQuery("424242"), ticketsGroup())).findByRole("option", lookup("424242")));

    expect(await screen.findByText("No ticket #424242 in Freshdesk")).toBeInTheDocument();
    expect(navigateToTicket).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the rate-limit message when Freshdesk asks Velo to slow down", async () => {
    await connectAndSync();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1005", rateLimited);
    openPalette();
    typeQuery("1005");
    fireEvent.click(await within(await ticketsGroup()).findByRole("option", lookup("1005")));

    expect(await screen.findByText("Freshdesk is rate limiting requests. Velo will try again later.")).toBeInTheDocument();
    expect(navigateToTicket).not.toHaveBeenCalled();
  });

  it("shows the API key error when Freshdesk rejects the credentials", async () => {
    await connectAndSync();
    stub.respondOnce(ALPHA_HOST, "/api/v2/tickets/1005", { status: 401, body: authenticationFailure });
    openPalette();
    typeQuery("1005");
    fireEvent.click(await within(await ticketsGroup()).findByRole("option", lookup("1005")));

    expect(await screen.findByText("Freshdesk rejected the API key. Check it and connect again.")).toBeInTheDocument();
    expect(navigateToTicket).not.toHaveBeenCalled();
  });

  it("offers no lookup with sample tickets, since no helpdesk is connected", async () => {
    openPalette();
    typeQuery("#77");

    const group = within(await ticketsGroup());
    expect(group.getByText(/^Sample tickets only/)).toBeInTheDocument();
    expect(group.queryByRole("option", lookup("77"))).not.toBeInTheDocument();
  });
});
