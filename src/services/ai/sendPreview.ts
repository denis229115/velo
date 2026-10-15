/**
 * The send preview contract between the AI gateway and the window that shows
 * previews. Kept apart from the gateway so UI surfaces can name the provider
 * and ask for a preview without loading the gateway itself.
 */
import type { AiFeature } from "./gateway";
import type { FlagCategory, SensitiveKind } from "./sensitiveData";

export const APPROVED_PROVIDER_LABEL = "Claude API (Anthropic)";

/** A source field or a sensitive-data type; the first request carrying one needs a send preview. */
export type AiDataKind =
  | "subject"
  | "message_text"
  | "status"
  | "priority"
  | "sender_domain"
  | "operator_request"
  | "task_name"
  | "task_status"
  | "task_description"
  | "task_comments"
  | SensitiveKind;

export interface SendPreview {
  feature: AiFeature;
  reason: "first_use" | "new_data_kind" | "requested";
  providerLabel: string;
  model: string;
  /** Exactly what will be sent */
  systemPrompt: string;
  userContent: string;
  /** Data kinds never sent before (empty on first use and when requested) */
  newKinds: AiDataKind[];
  flagCounts: Record<FlagCategory, number>;
}

/** Resolves true to send, false to cancel. */
export type SendPreviewHandler = (preview: SendPreview) => Promise<boolean>;

let previewHandler: SendPreviewHandler | null = null;
const previewRequested = new Set<AiFeature>();

/** Register the window that shows send previews; without one, a request that needs a preview is not sent. */
export function setSendPreviewHandler(handler: SendPreviewHandler | null): void {
  previewHandler = handler;
}

/** Show the send preview for the next request of these features, even when nothing is new. */
export function previewNextRequest(features: AiFeature[]): void {
  for (const feature of features) previewRequested.add(feature);
}

/** Called by the gateway: whether the operator asked to preview this feature's next request. */
export function takePreviewRequest(feature: AiFeature): boolean {
  return previewRequested.delete(feature);
}

export function getSendPreviewHandler(): SendPreviewHandler | null {
  return previewHandler;
}
