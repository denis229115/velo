import { fireEvent, render, screen } from "@testing-library/react";
import { ListHeader } from "./ListHeader";
import { ReadFilterTabs } from "./ReadFilterTabs";
import { useUIStore } from "@/stores/uiStore";
import { setSetting } from "@/services/db/settings";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

describe("ListHeader", () => {
  it("shows the breadcrumb, the page title and a count badge", () => {
    render(<ListHeader breadcrumb={["Mail", "alex@example.com"]} title="Inbox" count={15} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Mailalex@example.com");
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByTitle("15 conversations")).toHaveTextContent("15");
  });

  it("switches tabs and marks the active one", () => {
    const onTabChange = vi.fn();
    render(
      <ListHeader
        title="Tickets"
        tabs={[{ id: "open", label: "Open" }, { id: "mine", label: "Mine" }]}
        activeTab="open"
        onTabChange={onTabChange}
      />,
    );
    expect(screen.getByRole("tab", { name: "Open" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Mine" }));
    expect(onTabChange).toHaveBeenCalledWith("mine");
  });
});

describe("ReadFilterTabs", () => {
  beforeEach(() => {
    vi.mocked(setSetting).mockClear();
    useUIStore.setState({ readFilter: "all" });
  });

  it("replaces the read-filter dropdown with All and Unread tabs", () => {
    render(<ReadFilterTabs />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["All", "Unread"]);
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
  });

  it("filters to unread and persists the choice", () => {
    render(<ReadFilterTabs />);
    fireEvent.click(screen.getByRole("tab", { name: "Unread" }));
    expect(useUIStore.getState().readFilter).toBe("unread");
    expect(setSetting).toHaveBeenCalledWith("read_filter", "unread");
    expect(screen.getByRole("tab", { name: "Unread" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(setSetting).toHaveBeenLastCalledWith("read_filter", "all");
  });

  it("shows a restored Unread filter as the active tab", () => {
    useUIStore.setState({ readFilter: "unread" });
    render(<ReadFilterTabs />);
    expect(screen.getByRole("tab", { name: "Unread" })).toHaveAttribute("aria-selected", "true");
  });
});
