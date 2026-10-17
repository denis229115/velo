import { describe, it, expect, beforeEach, vi } from "vitest";

const mockComplete = vi.fn();
const mockStream = vi.fn();

// The AI answers by source item position (1-based), never by thread ID.
vi.mock("./gateway", async (importOriginal) => ({
  senderDomain: (await importOriginal<typeof import("./gateway")>()).senderDomain,
  requestAi: (req: unknown) => mockComplete(req),
  requestAiStream: (req: unknown, signal?: AbortSignal) => mockStream(req, signal),
}));

import { classifyThreadsBySmartLabels, transformText, transformTextStream } from "./aiService";
import { IMPROVE_PROMPT, SHORTEN_PROMPT, FORMALIZE_PROMPT } from "./prompts";

describe("text transforms", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([
    ["improve", IMPROVE_PROMPT],
    ["shorten", SHORTEN_PROMPT],
    ["formalize", FORMALIZE_PROMPT],
    ["warm", expect.stringContaining("warm, friendly, and approachable tone")],
    ["neutral", expect.stringContaining("neutral, matter-of-fact tone")],
  ] as const)("sends the %s instruction and selected text to both gateway APIs", async (type, systemPrompt) => {
    const selected = "<strong>Please send the invoice.</strong>";
    const request = { feature: "text_transform", systemPrompt, items: [{ body: selected }] };
    mockComplete.mockResolvedValueOnce("<strong>Rewritten</strong>");
    expect(await transformText(selected, type)).toBe("<strong>Rewritten</strong>");
    expect(mockComplete).toHaveBeenCalledExactlyOnceWith(request);

    const signal = new AbortController().signal;
    mockStream.mockReturnValueOnce((async function* () { yield "<strong>"; yield "Rewritten</strong>"; })());
    const chunks = [];
    for await (const chunk of transformTextStream(selected, type, signal)) chunks.push(chunk);
    expect(chunks).toEqual(["<strong>", "Rewritten</strong>"]);
    expect(mockStream).toHaveBeenCalledExactlyOnceWith(request, signal);
  });
});

describe("classifyThreadsBySmartLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const threads = [
    { id: "t1", subject: "Software Engineer Position", snippet: "We're hiring...", fromAddress: "recruiter@company.com" },
    { id: "t2", subject: "Your order shipped", snippet: "Package tracking...", fromAddress: "orders@shop.com" },
    { id: "t3", subject: "Team standup notes", snippet: "Meeting recap...", fromAddress: "pm@work.com" },
  ];

  const labelRules = [
    { labelId: "label-jobs", description: "Job applications and career opportunities" },
    { labelId: "label-orders", description: "Shopping orders and delivery updates" },
  ];

  it("parses valid AI response into assignments map", async () => {
    mockComplete.mockResolvedValueOnce("1:label-jobs\n2:label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
    expect(result.has("t3")).toBe(false);
  });

  it("supports multi-label assignments", async () => {
    mockComplete.mockResolvedValueOnce("1:label-jobs,label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs", "label-orders"]);
  });

  it("ignores unknown item ids", async () => {
    mockComplete.mockResolvedValueOnce("9:label-jobs\nx:label-orders\n1:label-jobs");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(1);
    expect(result.has("t3")).toBe(false);
    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("ignores invalid label IDs", async () => {
    mockComplete.mockResolvedValueOnce("1:label-jobs,fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("skips threads where all labels are invalid", async () => {
    mockComplete.mockResolvedValueOnce("1:fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles empty AI response", async () => {
    mockComplete.mockResolvedValueOnce("");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles blank lines and whitespace in response", async () => {
    mockComplete.mockResolvedValueOnce("\n  1:label-jobs  \n\n  2:label-orders\n");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(2);
    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
  });

  it("passes label definitions and thread subjects, previews and sender domains, not addresses", async () => {
    mockComplete.mockResolvedValueOnce("");

    await classifyThreadsBySmartLabels(threads, labelRules);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const req = mockComplete.mock.calls[0]![0] as { operatorText: string; items: unknown[] };
    expect(req.operatorText).toContain("label-jobs");
    expect(req.operatorText).toContain("Job applications");
    expect(req.items).toEqual([
      { subject: "Software Engineer Position", body: "We're hiring...", senderDomain: "company.com" },
      { subject: "Your order shipped", body: "Package tracking...", senderDomain: "shop.com" },
      { subject: "Team standup notes", body: "Meeting recap...", senderDomain: "work.com" },
    ]);
  });
});
