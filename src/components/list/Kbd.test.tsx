import { render } from "@testing-library/react";
import { Kbd } from "./Kbd";
import { pretendPlatform, restoreUserAgent } from "@/test/platform";

const chips = () => Array.from(document.querySelectorAll("kbd")).map((k) => k.textContent);

describe("Kbd", () => {
  afterEach(() => restoreUserAgent());

  it("shows single keys as capitals and named keys as symbols", () => {
    render(<><Kbd keys="j" /><Kbd keys="Enter" /><Kbd keys="?" /></>);
    expect(chips()).toEqual(["J", "↵", "?"]);
  });

  it("shows a two-key sequence as two chips", () => {
    render(<Kbd keys="g then i" />);
    expect(chips()).toEqual(["G", "I"]);
  });

  it("shows Cmd and Option on macOS", () => {
    pretendPlatform("mac");
    render(<Kbd keys="Ctrl+Alt+k" />);
    expect(chips()).toEqual(["Cmd", "Option", "K"]);
  });

  it("keeps Ctrl on Windows", () => {
    pretendPlatform("windows");
    render(<Kbd keys="Ctrl+k" />);
    expect(chips()).toEqual(["Ctrl", "K"]);
  });
});
