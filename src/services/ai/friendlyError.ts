import { AiError } from "./errors";

export interface FriendlyAiFailure {
  message: string;
  /** The operator can run the same request again. */
  retry: boolean;
}

/** A sentence the operator can act on. Policy and cancel messages stay exact. */
export function friendlyAiError(err: unknown): FriendlyAiFailure {
  if (err instanceof AiError) {
    switch (err.code) {
      case "CANCELLED":
      case "PREVIEW_REQUIRED":
      case "SENSITIVE_DATA":
      case "NOT_APPROVED":
      case "PROVIDER_REFUSED":
        return { message: err.message, retry: false };
      case "RATE_LIMITED":
        return { message: "The assistant is busy. Wait a moment and try again.", retry: true };
      case "AUTH_ERROR":
      case "NOT_CONFIGURED":
        return { message: "The assistant isn't signed in. Check AI settings and try again.", retry: true };
      case "NETWORK_ERROR":
        return { message: "Couldn't reach the assistant. Check your connection and try again.", retry: true };
      default:
        return { message: "Couldn't finish that. Try again.", retry: true };
    }
  }
  return { message: "Couldn't finish that. Try again.", retry: true };
}
