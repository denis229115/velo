import { render, screen, fireEvent } from "@testing-library/react";
import { Popover } from "./Popover";
import { QuickSchedulePicker } from "./QuickSchedulePicker";

it("flips a send-later picker above its footer anchor and keeps it inside a narrow viewport", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({ top: 350, bottom: 380, left: 230 } as DOMRect);
  const onSelect = vi.fn();
  render(<Popover open onClose={() => {}} title="Send later" anchorRef={{ current: anchor }}>
    <QuickSchedulePicker presets={[{ label: "Tomorrow", timestamp: 100 }]} onSelect={onSelect} submitLabel="Send later" />
  </Popover>);
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveStyle({ top: "8px", left: "8px", width: "264px", maxHeight: "336px" });
  expect(dialog).toHaveClass("overflow-y-auto");
  fireEvent.click(screen.getByText("Pick date & time"));
  expect(screen.getByLabelText("Time")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Tomorrow"));
  expect(onSelect).toHaveBeenCalledWith(100);
  height.mockRestore();
});
