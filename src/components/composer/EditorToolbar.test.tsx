import { render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { EditorToolbar } from "./EditorToolbar";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

const editor = { isActive: () => false } as unknown as Editor;

afterEach(restoreUserAgent);

describe("Editor toolbar tooltips", () => {
  it("shows Cmd wording on macOS", () => {
    pretendPlatform("mac");
    render(<EditorToolbar editor={editor} />);

    expect(screen.getByTitle("Bold (Cmd+B)")).toBeInTheDocument();
    expect(screen.getByTitle("Italic (Cmd+I)")).toBeInTheDocument();
    expect(screen.getByTitle("Underline (Cmd+U)")).toBeInTheDocument();
  });

  it("keeps Ctrl wording on Windows", () => {
    pretendPlatform("windows");
    render(<EditorToolbar editor={editor} />);

    expect(screen.getByTitle("Bold (Ctrl+B)")).toBeInTheDocument();
  });
});
