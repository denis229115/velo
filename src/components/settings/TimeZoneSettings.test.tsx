import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const setSetting = vi.fn(async (_key: string, _value: string) => {});
vi.mock("@/services/db/settings", () => ({ setSetting: (k: string, v: string) => setSetting(k, v) }));

import { useUIStore } from "@/stores/uiStore";
import { TimeZoneSettings } from "./TimeZoneSettings";

beforeEach(() => {
  setSetting.mockClear();
  useUIStore.setState({ timeZoneOverride: null, extraTimeZones: ["Europe/Berlin"] });
});

describe("TimeZoneSettings", () => {
  it("overrides the Mac's time zone and can go back to it", () => {
    render(<TimeZoneSettings />);
    const select = screen.getByLabelText("Show times in");
    fireEvent.change(select, { target: { value: "America/New_York" } });
    expect(useUIStore.getState().timeZoneOverride).toBe("America/New_York");
    expect(setSetting).toHaveBeenCalledWith("time_zone_override", "America/New_York");

    fireEvent.change(select, { target: { value: "" } });
    expect(useUIStore.getState().timeZoneOverride).toBeNull();
  });

  it("adds and removes extra zones shown on hover, starting with Berlin", () => {
    render(<TimeZoneSettings />);
    const list = screen.getByRole("list", { name: "Extra time zones" });
    expect(within(list).getByText("Europe/Berlin")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Add a time zone"), { target: { value: "Asia/Tokyo" } });
    expect(useUIStore.getState().extraTimeZones).toEqual(["Europe/Berlin", "Asia/Tokyo"]);
    expect(setSetting).toHaveBeenLastCalledWith("extra_time_zones", JSON.stringify(["Europe/Berlin", "Asia/Tokyo"]));

    fireEvent.click(screen.getByRole("button", { name: "Remove Europe/Berlin" }));
    expect(useUIStore.getState().extraTimeZones).toEqual(["Asia/Tokyo"]);
  });
});
