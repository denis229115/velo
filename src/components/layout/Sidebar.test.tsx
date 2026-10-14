import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createSqliteTestDb, type SqliteTestDb } from "@/test/sqliteTestDb";

let db: SqliteTestDb;
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => ({
      select: (sql: string, params?: unknown[]) => db.select(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params),
    })),
  },
}));
vi.mock("@dnd-kit/core", () => ({ useDroppable: () => ({ setNodeRef: () => {}, isOver: false }) }));
vi.mock("../accounts/AccountSwitcher", () => ({ AccountSwitcher: () => null }));

const testRouter = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/router", () => ({
  get router() {
    return testRouter.current;
  },
}));

import { runMigrations } from "@/services/db/migrations";
import { Sidebar } from "./Sidebar";

function renderSidebar(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Sidebar collapsed={false} onAddAccount={() => {}} />
        <Outlet />
      </>
    ),
  });
  const page = (name: string) => () => <main aria-label={name} />;
  const mailRoute = createRoute({ getParentRoute: () => rootRoute, path: "mail/$label", component: page("mail") });
  const freshdeskRoute = createRoute({ getParentRoute: () => rootRoute, path: "freshdesk", component: page("freshdesk") });
  const pageRoutes = ["tasks", "attachments", "scheduled"].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: page(path) }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([mailRoute, freshdeskRoute, ...pageRoutes]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  testRouter.current = router;
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(async () => {
  db = createSqliteTestDb();
  await runMigrations();
});

afterEach(() => {
  db.close();
});

describe("Sidebar sections", () => {
  it("shows Email and Freshdesk as separate sections, and Freshdesk opens the ticket list", async () => {
    const router = renderSidebar("/mail/inbox");

    const email = await screen.findByRole("group", { name: "Email" });
    const freshdesk = screen.getByRole("group", { name: "Freshdesk" });
    expect(within(email).getByRole("button", { name: /Inbox/ })).toBeInTheDocument();
    expect(within(email).queryByRole("button", { name: /Tickets/ })).toBeNull();

    fireEvent.click(within(freshdesk).getByRole("button", { name: /Tickets/ }));

    expect(await screen.findByRole("main", { name: "freshdesk" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/freshdesk");
    expect(within(freshdesk).getByRole("button", { name: /Tickets/ })).toHaveAttribute("aria-current", "page");
  });
});

describe("Sidebar active item", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  async function activeItems() {
    const email = await screen.findByRole("group", { name: "Email" });
    return within(email)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page")
      .map((b) => b.textContent?.trim());
  }

  describe.each([["light"], ["dark"]])("in the %s theme", (theme) => {
    beforeEach(() => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });

    it.each([
      ["/tasks", "Tasks"],
      ["/attachments", "Attachments"],
      ["/scheduled", "Scheduled"],
      ["/mail/inbox", "Inbox"],
      ["/mail/trash", "Trash"],
    ])("highlights only the matching item on %s", async (path, label) => {
      renderSidebar(path);

      expect(await activeItems()).toEqual([label]);
      const email = screen.getByRole("group", { name: "Email" });
      expect(within(email).getByRole("button", { name: label })).toHaveClass("bg-accent/10", "text-accent");
    });

    it("highlights Freshdesk Tickets and no email item on the ticket list", async () => {
      renderSidebar("/freshdesk");

      expect(await activeItems()).toEqual([]);
      const freshdesk = screen.getByRole("group", { name: "Freshdesk" });
      expect(within(freshdesk).getByRole("button", { name: /Tickets/ })).toHaveAttribute("aria-current", "page");
    });
  });
});
