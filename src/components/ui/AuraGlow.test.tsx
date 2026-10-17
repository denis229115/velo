import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AuraGlow } from "./AuraGlow";
import { resetAuraOwner } from "./auraOwner";

afterEach(() => {
  cleanup();
  resetAuraOwner();
});

describe("AuraGlow", () => {
  it("lights only the higher priority field", () => {
    render(
      <>
        <AuraGlow palette="halo" phase="working" priority={10}>Bar</AuraGlow>
        <AuraGlow palette="intelligence" phase="working" priority={30}>Editor</AuraGlow>
      </>,
    );
    const lit = document.querySelectorAll('[data-aura-on="true"]');
    expect(lit).toHaveLength(1);
    expect(lit[0]?.textContent).toContain("Editor");
    expect(screen.getByText("Bar").closest("[data-aura-on]")?.getAttribute("data-aura-on")).toBe("false");
  });

  it("hands the glow back when the owner unmounts", () => {
    const { rerender } = render(
      <>
        <AuraGlow palette="halo" phase="working" priority={10}>Bar</AuraGlow>
        <AuraGlow palette="intelligence" phase="working" priority={30}>Editor</AuraGlow>
      </>,
    );
    rerender(<AuraGlow palette="halo" phase="working" priority={10}>Bar</AuraGlow>);
    expect(screen.getByText("Bar").closest("[data-aura-on]")?.getAttribute("data-aura-on")).toBe("true");
  });
});
