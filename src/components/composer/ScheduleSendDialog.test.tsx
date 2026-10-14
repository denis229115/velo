import { render, screen } from "@testing-library/react";
import { ScheduleSendDialog } from "./ScheduleSendDialog";

describe("ScheduleSendDialog", () => {
  it("tells the operator scheduled emails only send while Velo is open", () => {
    render(<ScheduleSendDialog onSchedule={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText(/sends when Velo is next open/i)).toBeInTheDocument();
    expect(screen.getByText(/not while your Mac sleeps or Velo is closed/i)).toBeInTheDocument();
  });
});
