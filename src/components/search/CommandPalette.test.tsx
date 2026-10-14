import { render, screen } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateBack: vi.fn(),
  getSelectedThreadId: vi.fn(() => null),
}));
vi.mock("@/hooks/useRouteNavigation", () => ({ useActiveLabel: () => "inbox" }));
vi.mock("@/services/db/templates", () => ({ getTemplatesForAccount: vi.fn(async () => []) }));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));

afterEach(restoreUserAgent);

describe("Command palette shortcut hints", () => {
  it("shows Cmd wording on macOS", () => {
    pretendPlatform("mac");
    render(<CommandPalette isOpen onClose={() => {}} />);

    expect(screen.getByText("Cmd+Shift+E")).toBeInTheDocument();
  });

  it("keeps Ctrl wording on Windows", () => {
    pretendPlatform("windows");
    render(<CommandPalette isOpen onClose={() => {}} />);

    expect(screen.getByText("Ctrl+Shift+E")).toBeInTheDocument();
  });
});
