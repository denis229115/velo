import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { useUIStore } from "@/stores/uiStore";
import { OfflineBanner } from "./OfflineBanner";

async function renderAt(path: string) {
  const rootRoute = createRootRoute({ component: OfflineBanner });
  const tree = rootRoute.addChildren(
    ["inbox", "freshdesk", "tasks"].map((p) => createRoute({ getParentRoute: () => rootRoute, path: p })),
  );
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return router;
}

beforeEach(() => useUIStore.setState({ isOnline: false }));
afterEach(cleanup);

describe("OfflineBanner", () => {
  it("promises queued changes on email pages", async () => {
    await renderAt("/inbox");
    expect(screen.getByText("You're offline — changes will sync when you reconnect")).toBeInTheDocument();
  });

  it("on Freshdesk pages says ticket changes need a connection and are not queued", async () => {
    await renderAt("/freshdesk");
    expect(screen.getByText("You're offline — ticket changes need a connection and are not queued")).toBeInTheDocument();
    expect(screen.queryByText(/will sync/)).not.toBeInTheDocument();
  });

  it("takes its own space in the layout instead of floating over the page", async () => {
    await renderAt("/freshdesk");
    const banner = screen.getByText(/You're offline/).parentElement!;
    expect(banner).not.toHaveClass("fixed", "absolute");
    expect(banner).toHaveClass("shrink-0");
  });

  it("follows the operator between pages", async () => {
    const router = await renderAt("/freshdesk");
    await act(() => router.navigate({ to: "/inbox" }));
    expect(screen.getByText(/changes will sync when you reconnect/)).toBeInTheDocument();
  });

  it("is hidden online", async () => {
    useUIStore.setState({ isOnline: true });
    await renderAt("/freshdesk");
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument();
  });
});
