import { act, render, screen, fireEvent } from "@testing-library/react";
import { ConfirmHost } from "./ConfirmSheet";
import { requestConfirm } from "./confirmRequest";

it("uses a solid elevated dialog and resolves the explicit choice", async () => {
  render(<ConfirmHost />);
  let result!: Promise<boolean>;
  act(() => { result = requestConfirm({ title: "Delete?", message: "Permanently delete this email?", confirmLabel: "Delete", danger: true }); });
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveClass("bg-surface-overlay", "shadow-e3");
  expect(dialog).not.toHaveClass("material-pop");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await result).toBe(false);
});
