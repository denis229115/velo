import { afterEach, describe, expect, it } from "vitest";
import { claimAura, resetAuraOwner } from "./auraOwner";

afterEach(() => {
  resetAuraOwner();
});

describe("aura owner", () => {
  it("gives the glow to the higher priority and hands it back", () => {
    const low = claimAura(10);
    expect(low.owns()).toBe(true);
    const high = claimAura(30);
    expect(high.owns()).toBe(true);
    expect(low.owns()).toBe(false);
    high.release();
    expect(low.owns()).toBe(true);
    expect(high.owns()).toBe(false);
  });

  it("keeps the newer claim when the priority ties", () => {
    const first = claimAura(10);
    const second = claimAura(10);
    expect(second.owns()).toBe(true);
    expect(first.owns()).toBe(false);
    second.release();
    expect(first.owns()).toBe(true);
  });
});
