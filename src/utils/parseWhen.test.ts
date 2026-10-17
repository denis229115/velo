import { describe, expect, it } from "vitest";
import { parseWhen } from "./parseWhen";

/** Wednesday 15 January 2025, 10:00 local. */
const now = new Date(2025, 0, 15, 10, 0, 0);

describe("parseWhen", () => {
  it("reads tmr 8am as tomorrow morning", () => {
    expect(parseWhen("tmr 8am", now).date).toEqual(new Date(2025, 0, 16, 8, 0, 0));
  });

  it("reads a bare afternoon hour as today", () => {
    expect(parseWhen("3", now).date).toEqual(new Date(2025, 0, 15, 15, 0, 0));
  });

  it("moves a bare morning hour that has passed to the next morning", () => {
    expect(parseWhen("8", now).date).toEqual(new Date(2025, 0, 16, 8, 0, 0));
  });

  it("reads this weekend as Saturday at 9:00", () => {
    expect(parseWhen("this weekend", now).date).toEqual(new Date(2025, 0, 18, 9, 0, 0));
  });

  it("reads Monday 8am as the coming Monday", () => {
    expect(parseWhen("Monday 8am", now).date).toEqual(new Date(2025, 0, 20, 8, 0, 0));
  });

  it("treats someday as a choice with no instant", () => {
    expect(parseWhen("someday", now)).toEqual({ date: null, label: "Someday", someday: true });
  });

  it("returns no date when the phrase has no time", () => {
    expect(parseWhen("asdfqwer", now)).toEqual({ date: null, label: null, someday: false });
  });
});
