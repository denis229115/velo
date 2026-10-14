import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createFreshdeskFetchStub } from "@/test/freshdeskFetchStub";
import {
  ALPHA_HOST,
  BETA_HOST,
  alphaTenant,
  betaTenant,
} from "@/services/freshdesk/__fixtures__/freshdeskFixtures";

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
  encryptValue: vi.fn(async (v: string) => `enc:${btoa(v).split("").reverse().join("")}`),
  decryptValue: vi.fn(async (v: string) => atob(v.slice(4).split("").reverse().join(""))),
  isEncrypted: vi.fn((v: string) => v.startsWith("enc:")),
}));

const ALPHA_KEY = "fixture-key-alpha-0001";
let stub: ReturnType<typeof createFreshdeskFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import { FreshdeskSettings } from "./FreshdeskSettings";

vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(async () => {
  db = createSqliteTestDb();
  stub = createFreshdeskFetchStub({
    [ALPHA_HOST]: { apiKey: ALPHA_KEY, tenant: { ...alphaTenant } },
    [BETA_HOST]: { apiKey: "fixture-key-beta-0002", tenant: { ...betaTenant } },
  });
  await runMigrations();
});

afterEach(() => {
  db.close();
});

async function connect(host: string, apiKey: string) {
  fireEvent.change(await screen.findByLabelText("Helpdesk address"), { target: { value: host } });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: apiKey } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

function statusRows() {
  return within(screen.getByRole("table", { name: /status classes/i })).getAllByRole("row").slice(1);
}

// Role queries over the status table are slow in jsdom, especially under a full parallel run.
describe("FreshdeskSettings", { timeout: 15_000 }, () => {
  it("marks every sample status and ticket as sample until a helpdesk is connected", async () => {
    render(<FreshdeskSettings />);

    expect(await screen.findByText(/No helpdesk connected/i)).toBeInTheDocument();
    const rows = await waitFor(() => {
      const r = statusRows();
      expect(r.length).toBeGreaterThan(0);
      return r;
    });
    for (const row of rows) expect(within(row).getByText("Sample")).toBeInTheDocument();

    const tickets = within(screen.getByRole("list", { name: /sample tickets/i })).getAllByRole("listitem");
    expect(tickets.length).toBeGreaterThan(0);
    for (const ticket of tickets) expect(within(ticket).getByText("Sample")).toBeInTheDocument();
  });

  it("connects and shows the helpdesk's exact status labels and IDs, and who I am", async () => {
    render(<FreshdeskSettings />);
    await connect(ALPHA_HOST, ALPHA_KEY);

    expect(await screen.findByText(`Connected to ${ALPHA_HOST}`)).toBeInTheDocument();
    expect(screen.getByText(/Fixture Operator/)).toBeInTheDocument();
    expect(screen.getByText(/agent ID 9000000002/)).toBeInTheDocument();

    const rows = statusRows();
    expect(rows.map((r) => within(r).getAllByRole("cell").slice(0, 2).map((c) => c.textContent))).toEqual([
      ["Open", "2"],
      ["Pending", "3"],
      ["Resolved", "4"],
      ["Closed", "5"],
      ["Fixture: With engineering", "6"],
    ]);
    expect(screen.queryByText("Sample")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /sample tickets/i })).not.toBeInTheDocument();
    // The key is never shown back once stored.
    expect(screen.queryByDisplayValue(ALPHA_KEY)).not.toBeInTheDocument();
  });

  it("keeps each status class after the screen is opened again", async () => {
    const { unmount } = render(<FreshdeskSettings />);
    await connect(ALPHA_HOST, ALPHA_KEY);
    await screen.findByText(`Connected to ${ALPHA_HOST}`);

    fireEvent.change(screen.getByLabelText("Status class for Fixture: With engineering"), {
      target: { value: "waiting" },
    });
    await waitFor(async () => {
      expect(await db.select("SELECT status_id, status_class FROM freshdesk_status_classes")).toEqual([
        { status_id: "6", status_class: "waiting" },
      ]);
    });
    unmount();

    render(<FreshdeskSettings />);
    await waitFor(() =>
      expect(screen.getByLabelText("Status class for Fixture: With engineering")).toHaveValue("waiting"),
    );
    expect(screen.getByLabelText("Status class for Pending")).toHaveValue("");
  });

  it("shows a rejected API key as an error without echoing it", async () => {
    render(<FreshdeskSettings />);
    await connect(ALPHA_HOST, "wrong-key-123");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/rejected the API key/i);
    expect(alert).not.toHaveTextContent("wrong-key-123");
    expect(screen.getByText(/No helpdesk connected/i)).toBeInTheDocument();
  });

  it("disconnects back to sample data", async () => {
    render(<FreshdeskSettings />);
    await connect(ALPHA_HOST, ALPHA_KEY);
    await screen.findByText(`Connected to ${ALPHA_HOST}`);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(await screen.findByText(/No helpdesk connected/i)).toBeInTheDocument();
    await waitFor(() => expect(within(statusRows()[0]!).getByText("Sample")).toBeInTheDocument());
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });
});
