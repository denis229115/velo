import { describe, expect, it } from "vitest";
import { AiError } from "./errors";
import { friendlyAiError } from "./friendlyError";

describe("friendlyAiError", () => {
  it("turns a network failure into a retryable sentence", () => {
    expect(friendlyAiError(new AiError("NETWORK_ERROR", "Network unavailable"))).toEqual({
      message: "Couldn't reach the assistant. Check your connection and try again.",
      retry: true,
    });
  });

  it("keeps a cancellation exactly as the provider said it", () => {
    expect(friendlyAiError(new AiError("CANCELLED", "Not sent: you cancelled the send preview."))).toEqual({
      message: "Not sent: you cancelled the send preview.",
      retry: false,
    });
  });
});
