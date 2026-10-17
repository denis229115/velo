import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Combobox } from "./Combobox";

const options = [
  { id: "ada", label: "Ada Lovelace", detail: "Support" },
  { id: "grace", label: "Grace Hopper", detail: "Engineering" },
];

describe("Combobox", () => {
  it("filters with the keyboard and selects the active option", () => {
    const onChange = vi.fn();
    render(
      <Combobox
        label="Assignee"
        options={options}
        pinned={[{ id: "", label: "Unassigned" }]}
        value={null}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Assignee" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "Assignee" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "hop" } });
    expect(screen.getByRole("option", { name: /Grace Hopper/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Ada Lovelace/ })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("grace");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("selects Unassigned as an empty id", () => {
    const onChange = vi.fn();
    render(
      <Combobox
        label="Assignee"
        options={options}
        pinned={[{ id: "", label: "Unassigned" }]}
        value="ada"
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Assignee" });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
