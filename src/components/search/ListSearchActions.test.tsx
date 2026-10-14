import { render, screen, fireEvent } from "@testing-library/react";
import { ListSearchActions } from "./ListSearchActions";
import { useThreadStore } from "@/stores/threadStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";

beforeEach(() => {
  useThreadStore.setState({ searchQuery: "", searchThreadIds: null });
});

describe("List search actions", () => {
  it("shows no search button: the sidebar header holds the only one", () => {
    render(<ListSearchActions />);
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();

    useThreadStore.setState({ searchQuery: "from:alice" });
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("clears an active search", () => {
    useThreadStore.setState({ searchQuery: "from:alice" });
    render(<ListSearchActions />);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(useThreadStore.getState().searchQuery).toBe("");
  });

  it("saves an active search as a smart folder", () => {
    const createFolder = vi.fn();
    useSmartFolderStore.setState({ createFolder });
    useThreadStore.setState({ searchQuery: "from:alice" });
    render(<ListSearchActions />);

    fireEvent.click(screen.getByRole("button", { name: "Save as Smart Folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(createFolder).toHaveBeenCalledWith("from:alice", "from:alice", undefined);
  });
});
