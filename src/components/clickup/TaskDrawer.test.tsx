import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Modal } from "@/components/ui/Modal";
import { TaskDrawer } from "./TaskDrawer";

function Example() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  return <><button onClick={() => setOpen(true)}>Create task</button>{open && <TaskDrawer title="Task details" onClose={() => setOpen(false)}><input aria-label="Title" autoFocus /><button onClick={() => setPreview(true)}>Last action</button></TaskDrawer>}{preview && <Modal isOpen title="Send preview" onClose={() => setPreview(false)}><button onClick={() => setPreview(false)}>Cancel preview</button><button>Approve preview</button></Modal>}</>;
}

describe("task drawer keyboard", () => {
  it("lets the AI send preview own focus and Escape, then restores focus to the proposal controls", async () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    const previewOpener = screen.getByRole("button", { name: "Last action" });
    previewOpener.focus();
    fireEvent.click(previewOpener);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("×"));
    const approve = screen.getByRole("button", { name: "Approve preview" });
    approve.focus();
    fireEvent.keyDown(approve, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("×");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(previewOpener).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Task details" })).toBeInTheDocument();
  });

  it("traps focus in both directions, dismisses on Escape and returns focus to its opener", () => {
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Create task" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("dialog", { name: "Task details" });
    const close = screen.getByRole("button", { name: "Close Task details" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(close).toHaveFocus();
    opener.focus();
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
