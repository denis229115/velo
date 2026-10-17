import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useUIStore } from "@/stores/uiStore";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { useComposerStore } from "@/stores/composerStore";

vi.mock("@/components/email/ThreadView", () => ({
  ThreadView: ({ thread }: { thread: { subject: string | null } }) => (
    <h1>{thread.subject ?? "(No subject)"}</h1>
  ),
}));

vi.mock("@/components/layout/EmailList", () => ({
  EmailList: () => <div data-testid="email-list">Inbox</div>,
}));

const testRouter = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/router", () => ({
  get router() {
    return testRouter.current;
  },
}));

import { MailLayout } from "./MailLayout";

const SUBJECT = "Quarterly review";

function makeThread(): Thread {
  return {
    id: "t1",
    accountId: "a1",
    subject: SUBJECT,
    snippet: "Please read",
    lastMessageAt: 1,
    messageCount: 2,
    isRead: true,
    isStarred: false,
    isPinned: false,
    isMuted: false,
    hasAttachments: false,
    labelIds: ["INBOX"],
    fromName: "Ada",
    fromAddress: "ada@example.com",
  };
}

async function renderMail(path: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const mailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "mail/$label",
    component: MailLayout,
  });
  const threadRoute = createRoute({
    getParentRoute: () => mailRoute,
    path: "thread/$threadId",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([mailRoute.addChildren([threadRoute])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  testRouter.current = router;
  await router.load();
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return router;
}

beforeEach(() => {
  useUIStore.setState({ readingPanePosition: "hidden" });
  useComposerStore.setState({ isOpen: false });
  const thread = makeThread();
  useThreadStore.setState({
    threads: [thread],
    threadMap: new Map([[thread.id, thread]]),
    selectedThreadIds: new Set(),
  });
});

afterEach(() => {
  useUIStore.setState({ readingPanePosition: "right" });
  useComposerStore.setState({ isOpen: false });
  useThreadStore.setState({
    threads: [],
    threadMap: new Map(),
    selectedThreadIds: new Set(),
  });
});

describe("MailLayout hidden reading pane", () => {
  it("opens the selected thread in a dialog over the list", async () => {
    await renderMail("/mail/inbox/thread/t1");

    const dialog = await screen.findByRole("dialog", { name: SUBJECT });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("bg-surface-reader", "overlay-shadow");
    expect(dialog.parentElement).toHaveClass("z-40");
    expect(dialog.parentElement).not.toHaveClass("z-50");
    expect(within(dialog).getByRole("heading", { name: SUBJECT })).toBeInTheDocument();
    expect(screen.getByTestId("email-list")).toBeInTheDocument();
    expect(dialog).not.toContainElement(screen.getByTestId("email-list"));
  });

  it("closes on Escape and leaves the list in place", async () => {
    const router = await renderMail("/mail/inbox/thread/t1");
    const dialog = await screen.findByRole("dialog", { name: SUBJECT });

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("email-list")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/mail/inbox");
  });

  it("closes from the close control and the backdrop", async () => {
    const router = await renderMail("/mail/inbox/thread/t1");
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(router.state.location.pathname).toBe("/mail/inbox");

    await act(async () => {
      await router.navigate({
        to: "/mail/$label/thread/$threadId",
        params: { label: "inbox", threadId: "t1" },
      });
    });
    const dialog = await screen.findByRole("dialog", { name: SUBJECT });
    const scrim = dialog.parentElement?.querySelector(".absolute");
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim!);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(router.state.location.pathname).toBe("/mail/inbox");
  });

  it("leaves the thread open when Escape belongs to the composer", async () => {
    useComposerStore.setState({ isOpen: true });
    await renderMail("/mail/inbox/thread/t1");
    const dialog = await screen.findByRole("dialog", { name: SUBJECT });

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(dialog).toBeInTheDocument();
  });

  it("shows no dialog until a thread is selected", async () => {
    await renderMail("/mail/inbox");
    expect(await screen.findByTestId("email-list")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a right reading pane inline", async () => {
    useUIStore.setState({ readingPanePosition: "right" });
    await renderMail("/mail/inbox/thread/t1");

    expect(await screen.findByRole("heading", { name: SUBJECT })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("email-list")).toBeInTheDocument();
  });

  it("keeps a bottom reading pane inline", async () => {
    useUIStore.setState({ readingPanePosition: "bottom" });
    await renderMail("/mail/inbox/thread/t1");

    expect(await screen.findByRole("heading", { name: SUBJECT })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("email-list")).toBeInTheDocument();
  });
});
