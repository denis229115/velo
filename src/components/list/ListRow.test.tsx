import { fireEvent, render, screen } from "@testing-library/react";
import { ListRow, type ListRowProps } from "./ListRow";

const NOW = new Date(2026, 9, 14, 15, 0).getTime();

function renderRow(overrides: Partial<ListRowProps> = {}) {
  const props: ListRowProps = {
    density: "compact",
    unread: true,
    sender: "Alice Walker",
    subject: "Quarterly report",
    preview: "Numbers attached for review",
    time: NOW - 60_000,
    onClick: vi.fn(),
    ...overrides,
  };
  render(<ListRow {...props} />);
  return props;
}

const line = (text: string) => screen.getByText(text).closest("[data-line]");

describe("ListRow", () => {
  it("puts dot, initials, sender, subject, preview, attachment and time on one compact line", () => {
    renderRow({ hasAttachment: true });
    expect(screen.getByTitle("Unread")).toBeInTheDocument();
    expect(screen.getByText("AW")).toBeInTheDocument();
    const row = line("Alice Walker");
    expect(row).not.toBeNull();
    expect(line("Quarterly report")).toBe(row);
    expect(line("Numbers attached for review")).toBe(row);
    expect(row).toContainElement(screen.getByTitle("Has attachments"));
    expect(row?.querySelector("time")).toHaveClass("tabular-nums");
  });

  it("keeps the compact row on one line in a wide list and folds the subject under the sender in a narrow one", () => {
    renderRow();
    const subjectGroup = screen.getByText("Quarterly report").parentElement;
    expect(subjectGroup).toHaveClass("basis-full", "@2xl:basis-auto");
    expect(screen.getByText("Alice Walker").closest("button")).toHaveClass("@2xl:h-11");
  });

  it("marks unread with a medium weight and a dot instead of bold", () => {
    renderRow();
    expect(screen.getByText("Alice Walker")).toHaveClass("font-[550]");
    expect(screen.getByText("Alice Walker").className).not.toMatch(/font-(bold|semibold)/);
  });

  it("shows read rows without the dot and at normal weight", () => {
    renderRow({ unread: false });
    expect(screen.queryByTitle("Unread")).not.toBeInTheDocument();
    expect(screen.getByText("Alice Walker")).not.toHaveClass("font-[550]");
  });

  it("uses two lines in comfortable density", () => {
    renderRow({ density: "default" });
    expect(line("Alice Walker")).not.toBe(line("Quarterly report"));
    expect(line("Quarterly report")).toBe(line("Numbers attached for review"));
  });

  it("reveals a star toggle on hover and keeps it visible once set", () => {
    const onToggleStar = vi.fn();
    const props = renderRow({ onToggleStar });
    const star = screen.getByRole("button", { name: "Star" });
    expect(star).toHaveClass("opacity-0", "group-hover:opacity-100");
    fireEvent.click(star);
    expect(onToggleStar).toHaveBeenCalledOnce();
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it("shows a set star without hovering", () => {
    renderRow({ starred: true, onToggleStar: vi.fn() });
    expect(screen.getByRole("button", { name: "Unstar" })).not.toHaveClass("opacity-0");
  });

  it.each(["compact", "default"] as const)("puts extra details on their own line under the subject in %s density", (density) => {
    renderRow({ density, extraLine: "Due Thu, Oct 15" });
    const extra = line("Due Thu, Oct 15");
    expect(extra).not.toBeNull();
    expect(extra).not.toBe(line("Quarterly report"));
    expect(extra).not.toBe(line("Alice Walker"));
    // The details come after the subject, and the row grows to hold them instead of clipping
    expect(line("Quarterly report")?.compareDocumentPosition(extra as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("Alice Walker").closest("button")).not.toHaveClass("@2xl:h-11");
  });

  it("renders no extra line when there are no extra details", () => {
    renderRow();
    expect(document.querySelectorAll("[data-line]")).toHaveLength(1);
  });

  it("opens the item when the row is clicked", () => {
    const props = renderRow();
    fireEvent.click(screen.getByText("Quarterly report"));
    expect(props.onClick).toHaveBeenCalledOnce();
  });

  it("offers hover quick actions without opening the item", () => {
    const onArchive = vi.fn();
    const props = renderRow({ actions: [{ label: "Archive", icon: () => null, onAction: onArchive }] });
    const archive = screen.getByRole("button", { name: "Archive" });
    fireEvent.click(archive);
    expect(onArchive).toHaveBeenCalledOnce();
    expect(props.onClick).not.toHaveBeenCalled();
  });
});
