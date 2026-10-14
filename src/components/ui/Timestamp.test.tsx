import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/db/settings", () => ({ setSetting: vi.fn(async () => {}) }));

import { useUIStore } from "@/stores/uiStore";
import { DateOnly, Timestamp } from "./Timestamp";

const NOW = Date.parse("2026-10-14T12:00:00Z");
/** Three hours before NOW: 09:00 UTC */
const AT = NOW - 3 * 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  useUIStore.setState({ timeZoneOverride: "Asia/Tokyo", extraTimeZones: ["Europe/Berlin"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const tooltipRows = () =>
  screen.getAllByRole("row").map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "");

describe("Timestamp", () => {
  it("shows a relative time, and on hover the exact time in the display zone plus each extra zone", () => {
    render(<Timestamp at={AT} />);
    const time = screen.getByText("3 h ago");
    expect(time).toHaveAttribute("datetime", "2026-10-14T09:00:00.000Z");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseEnter(time);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    const [local, berlin] = tooltipRows();
    // 09:00 UTC is 18:00 in Tokyo and 11:00 in Berlin (CEST)
    expect(local).toMatch(/Asia\/Tokyo/);
    expect(local).toMatch(/18:00|6:00\sPM/);
    expect(local).toMatch(/Oct(ober)? 14|14 Oct/);
    expect(berlin).toMatch(/Europe\/Berlin/);
    expect(berlin).toMatch(/11:00|11:00\sAM/);

    fireEvent.mouseLeave(time);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("the time zone override changes what is shown", () => {
    render(<Timestamp at={AT} />);
    act(() => useUIStore.getState().setTimeZoneOverride("America/New_York"));
    fireEvent.mouseEnter(screen.getByText("3 h ago"));
    const [local] = tooltipRows();
    // 09:00 UTC is 05:00 in New York (EDT)
    expect(local).toMatch(/America\/New_York/);
    expect(local).toMatch(/05:00|5:00\sAM/);
  });

  it("lists every extra zone the operator added, once each", () => {
    act(() => useUIStore.getState().setExtraTimeZones(["Europe/Berlin", "America/Los_Angeles", "Europe/Berlin"]));
    render(<Timestamp at={AT} />);
    fireEvent.focus(screen.getByText("3 h ago"));
    expect(tooltipRows().map((r) => r.match(/[A-Z][a-z]+\/[A-Za-z_]+/)?.[0])).toEqual([
      "Asia/Tokyo",
      "Europe/Berlin",
      "America/Los_Angeles",
    ]);
  });

  it("older instants show a date in the display zone", () => {
    // 2026-10-01T20:00Z is already 2 October in Tokyo
    render(<Timestamp at={Date.parse("2026-10-01T20:00:00Z")} />);
    expect(screen.getByText(/Oct(ober)? 2|2 Oct/)).toBeInTheDocument();
  });
});

describe("DateOnly", () => {
  it.each(["Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/Berlin"])("a date-only deadline is the same calendar day in %s", (zone) => {
    useUIStore.setState({ timeZoneOverride: zone });
    render(<DateOnly value="2026-10-15" />);
    expect(screen.getByText(/Oct(ober)? 15|15 Oct/)).toBeInTheDocument();
  });
});
