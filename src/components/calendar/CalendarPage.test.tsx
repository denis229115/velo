import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listCalendars = vi.hoisted(() => vi.fn());

const accountState = vi.hoisted(() => ({
  activeAccountId: "acc-caldav" as string | null,
  accounts: [] as Array<{
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    isActive: boolean;
    provider: string;
    calendar_provider?: string;
  }>,
}));

vi.mock("@/stores/accountStore", () => ({
  useAccountStore: (selector: (state: typeof accountState) => unknown) => selector(accountState),
}));

vi.mock("@/services/db/calendarEvents", () => ({
  getCalendarEventsInRangeMulti: vi.fn().mockResolvedValue([]),
  upsertCalendarEvent: vi.fn(),
}));

vi.mock("@/services/db/calendars", () => ({
  getVisibleCalendars: vi.fn().mockResolvedValue([]),
  getCalendarsForAccount: vi.fn().mockResolvedValue([]),
  upsertCalendar: vi.fn(),
}));

vi.mock("@/services/calendar/providerFactory", () => ({
  hasCalendarSupport: vi.fn().mockResolvedValue(true),
  getCalendarProvider: vi.fn(async () => ({
    type: "caldav",
    listCalendars,
    fetchEvents: vi.fn().mockResolvedValue([]),
  })),
}));

import { CalendarPage } from "./CalendarPage";

const imapCalDavAccount = {
  id: "acc-caldav",
  email: "user@winning-solutions.de",
  displayName: "Denis",
  avatarUrl: null,
  isActive: true,
  provider: "imap",
  calendar_provider: "caldav",
};

const gmailAccount = {
  id: "acc-gmail",
  email: "user@gmail.com",
  displayName: "Denis",
  avatarUrl: null,
  isActive: true,
  provider: "gmail_api",
};

beforeEach(() => {
  listCalendars.mockReset();
  accountState.activeAccountId = imapCalDavAccount.id;
  accountState.accounts = [imapCalDavAccount];
});

describe("CalendarPage", () => {
  it("shows a CalDAV load failure in the error banner", async () => {
    listCalendars.mockRejectedValue(new Error("Failed to fetch"));

    render(<CalendarPage />);

    expect(await screen.findByText("Calendar access error")).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    expect(screen.queryByText("Calendar requires re-authorization")).not.toBeInTheDocument();
  });

  it("does not treat a CalDAV 403 as Google reauth", async () => {
    listCalendars.mockRejectedValue(new Error("403 Forbidden"));

    render(<CalendarPage />);

    expect(await screen.findByText("Calendar access error")).toBeInTheDocument();
    expect(screen.getByText("403 Forbidden")).toBeInTheDocument();
    expect(screen.queryByText("Calendar requires re-authorization")).not.toBeInTheDocument();
  });

  it("keeps a Gmail API 403 on the reauth banner", async () => {
    accountState.activeAccountId = gmailAccount.id;
    accountState.accounts = [gmailAccount];
    listCalendars.mockRejectedValue(new Error("403 insufficient calendar permission"));

    render(<CalendarPage />);

    expect(await screen.findByText("Calendar requires re-authorization")).toBeInTheDocument();
    expect(screen.queryByText("Calendar access error")).not.toBeInTheDocument();
  });
});
