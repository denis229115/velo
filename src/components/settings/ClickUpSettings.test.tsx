import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";
import { createClickUpFetchStub } from "@/test/clickupFetchStub";
import { ALPHA_TOKEN, clickupTokens } from "@/services/clickup/__fixtures__/clickupFixtures";

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
let stub: ReturnType<typeof createClickUpFetchStub>;
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string, init?: RequestInit) => stub.fetch(input, init),
}));

import { runMigrations } from "@/services/db/migrations";
import { getClickUpSettings } from "@/services/clickup/connection";
import { ClickUpSettings } from "./ClickUpSettings";

vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(async () => {
  db = createSqliteTestDb();
  stub = createClickUpFetchStub(clickupTokens);
  await runMigrations();
});

afterEach(() => {
  db.close();
});

async function connect() {
  render(<ClickUpSettings />);
  fireEvent.change(await screen.findByLabelText("API token"), { target: { value: ALPHA_TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText(/Connected to Fixture Workspace Alpha/);
}

describe("Settings → ClickUp", () => {
  it("shows sample lists, each marked Sample, until a workspace is connected", async () => {
    render(<ClickUpSettings />);

    const lists = await screen.findByRole("list", { name: "Lists" });
    const items = within(lists).getAllByRole("listitem");
    expect(items.map((i) => within(i).getByText(/^Sample list/).textContent)).toEqual(["Sample list one", "Sample list two"]);
    for (const item of items) expect(within(item).getByText("Sample")).toBeInTheDocument();
    expect(screen.getByText(/sample data, not your workspace/)).toBeInTheDocument();
  });

  it("connects with a token and shows the workspace's lists, statuses, members and custom fields", async () => {
    await connect();

    const lists = screen.getByRole("list", { name: "Lists" });
    expect(within(lists).getByText("Fixture bugs")).toBeInTheDocument();
    expect(within(lists).getByText(/fixture waiting on vendor/)).toBeInTheDocument();
    expect(within(lists).queryByText("Sample")).not.toBeInTheDocument();
    expect(screen.getByText(/Fixture Colleague, Fixture Operator/)).toBeInTheDocument();
    expect(screen.queryByLabelText("API token")).not.toBeInTheDocument();
  });

  it("saves the default list and the Ticket-ID field", async () => {
    await connect();

    fireEvent.change(screen.getByLabelText("Default list"), { target: { value: "li_a_follow" } });
    fireEvent.change(screen.getByLabelText("Ticket-ID field"), { target: { value: "cf-alpha-ticket" } });

    await waitFor(async () => {
      const settings = await getClickUpSettings();
      expect(settings.defaultListId).toBe("li_a_follow");
      expect(settings.ticketIdFieldId).toBe("cf-alpha-ticket");
    });
  });

  it("shows ClickUp's rejection of a token and stays on sample lists", async () => {
    render(<ClickUpSettings />);
    fireEvent.change(await screen.findByLabelText("API token"), { target: { value: "pk_wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected the API token/);
    expect(screen.getAllByText("Sample").length).toBeGreaterThan(0);
  });

  it("disconnects back to sample lists", async () => {
    await connect();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(await screen.findByText(/sample data, not your workspace/)).toBeInTheDocument();
  });
});
