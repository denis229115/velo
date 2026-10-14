import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { DbMessage } from "@/services/db/messages";

vi.mock("@/services/ai/taskExtraction", () => ({ extractTask: vi.fn() }));
vi.mock("@/services/db/tasks", () => ({ insertTask: vi.fn(), getIncompleteTaskCount: vi.fn() }));

import { extractTask } from "@/services/ai/taskExtraction";
import { takePreviewRequest } from "@/services/ai/sendPreview";
import { AiTaskExtractDialog } from "./AiTaskExtractDialog";

const messages = [{ id: "m1", subject: "Send the report" }] as DbMessage[];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AiTaskExtractDialog", () => {
  it("names the provider and reruns the extraction through the send preview", async () => {
    vi.mocked(extractTask).mockResolvedValue({ title: "Send the report", priority: "medium" });

    render(<AiTaskExtractDialog threadId="thread-1" accountId="acc-1" messages={messages} onClose={() => {}} />);

    expect(await screen.findByDisplayValue("Send the report")).toBeInTheDocument();
    expect(screen.getByText("Sends to Claude API (Anthropic)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(extractTask).toHaveBeenCalledTimes(2));
    expect(takePreviewRequest("task_extraction")).toBe(true);
  });
});
