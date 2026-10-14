import { render, screen } from "@testing-library/react";
import { Keyboard } from "lucide-react";
import { HelpCard } from "./HelpCard";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

vi.mock("@/router/navigate", () => ({ navigateToSettings: vi.fn() }));

const card = {
  id: "keys",
  icon: Keyboard,
  title: "Keys",
  summary: "Shortcuts",
  description: "Description",
  tips: [{ text: "Send now", shortcut: "Ctrl+Enter" }, { text: "Open", shortcut: "o" }],
};

afterEach(restoreUserAgent);

describe("Help card shortcut tips", () => {
  it("shows Cmd wording on macOS", () => {
    pretendPlatform("mac");
    render(<HelpCard card={card} isExpanded onToggle={() => {}} />);

    expect(screen.getByText("Cmd+Enter")).toBeInTheDocument();
    expect(screen.getByText("o")).toBeInTheDocument();
  });

  it("keeps Ctrl wording on Windows", () => {
    pretendPlatform("windows");
    render(<HelpCard card={card} isExpanded onToggle={() => {}} />);

    expect(screen.getByText("Ctrl+Enter")).toBeInTheDocument();
  });
});
