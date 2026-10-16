import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import type { AiFeature } from "@/services/ai/gateway";
import {
  APPROVED_PROVIDER_LABEL,
  previewNextRequest,
  setSendPreviewHandler,
  type AiDataKind,
  type SendPreview,
} from "@/services/ai/sendPreview";

const KIND_LABELS: Record<AiDataKind, string> = {
  subject: "subject",
  message_text: "public message text",
  status: "status",
  priority: "priority",
  sender_domain: "sender domain",
  operator_request: "your instruction",
  task_name: "ClickUp task name",
  task_status: "ClickUp task status",
  task_description: "ClickUp task description",
  task_comments: "ClickUp task comments",
  secret: "secret",
  card: "card number",
  iban: "IBAN",
  bank: "bank details",
  email: "email address",
  phone: "phone number",
  address: "postal address",
};

function reasonText(preview: SendPreview): string {
  switch (preview.reason) {
    case "first_use":
      return "This is Velo's first AI request. Check what will be sent.";
    case "new_data_kind":
      return `This request includes data not sent before: ${preview.newKinds.map((k) => KIND_LABELS[k]).join(", ")}.`;
    case "requested":
      return "You asked to see this request before it is sent.";
  }
}

function flagText({ secret, payment, contact }: SendPreview["flagCounts"]): string | null {
  const parts: string[] = [];
  if (payment + contact > 0) {
    parts.push(`${payment} payment and ${contact} contact details replaced with placeholders`);
  }
  if (secret > 0) parts.push(`${secret} ${secret === 1 ? "secret" : "secrets"} removed`);
  return parts.length > 0 ? `${parts.join("; ")}.` : null;
}

/**
 * Shows the send preview whenever the AI gateway asks for one. Mounted once per
 * window; while it is not mounted, requests that need a preview are not sent.
 */
export function AiSendPreviewHost() {
  const [pending, setPending] = useState<{
    preview: SendPreview;
    resolve: (send: boolean) => void;
  } | null>(null);

  useEffect(() => {
    setSendPreviewHandler(
      (preview) => new Promise<boolean>((resolve) => setPending({ preview, resolve })),
    );
    return () => setSendPreviewHandler(null);
  }, []);

  const answer = (send: boolean) => {
    pending?.resolve(send);
    setPending(null);
  };

  const preview = pending?.preview;
  const flags = preview ? flagText(preview.flagCounts) : null;

  return (
    <Modal isOpen={!!preview} onClose={() => answer(false)} title="Send preview" width="w-[36rem]">
      {preview && (
        <div className="p-4 space-y-3 text-sm">
          <p className="text-text-primary">
            Sends to {preview.providerLabel} · model {preview.model}
          </p>
          <p className="text-text-secondary">{reasonText(preview)}</p>
          {flags && <p className="text-text-secondary">{flags}</p>}
          <div>
            <div className="text-xs text-text-tertiary mb-1">Instructions</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-bg-secondary p-2 text-xs text-text-primary">
              {preview.systemPrompt}
            </pre>
          </div>
          <div>
            <div className="text-xs text-text-tertiary mb-1">Content</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bg-secondary p-2 text-xs text-text-primary">
              {preview.userContent || "(none)"}
            </pre>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => answer(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => answer(true)}>
              Send to {preview.providerLabel}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Names the provider at the point of sending and keeps the send preview one
 * click away. `onPreview` reruns the surface's request, if it has one to rerun.
 */
export function AiSendNote({
  features,
  onPreview,
}: {
  features: AiFeature[];
  onPreview?: () => void;
}) {
  const [armed, setArmed] = useState(false);

  return (
    <div className="flex items-center gap-2 text-[0.6875rem] text-text-tertiary">
      <span>Sends to {APPROVED_PROVIDER_LABEL}</span>
      <button
        type="button"
        onClick={() => {
          previewNextRequest(features);
          if (onPreview) onPreview();
          else setArmed(true);
        }}
        className="underline hover:text-text-secondary"
      >
        Preview
      </button>
      {armed && <span>The next request shows the preview first.</span>}
    </div>
  );
}
