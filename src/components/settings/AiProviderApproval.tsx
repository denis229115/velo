import { ShieldAlert } from "lucide-react";
import { APPROVED_PROVIDER, APPROVED_PROVIDER_LABEL, providerRefusalMessage } from "@/services/ai/gateway";
import type { AiProvider } from "@/services/ai/types";

interface AiProviderApprovalProps {
  provider: AiProvider;
  approved: boolean;
  onApprovedChange: (approved: boolean) => void;
}

/**
 * Only the approved provider may receive email, ticket or task content. Other
 * providers are refused with a reason; the Claude API stays off until approved.
 */
export function AiProviderApproval({ provider, approved, onApprovedChange }: AiProviderApprovalProps) {
  if (provider !== APPROVED_PROVIDER) {
    return (
      <div role="alert" className="flex items-start gap-2 p-3 rounded-md border border-warning/40 bg-warning/10">
        <ShieldAlert size={14} className="text-warning shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary">{providerRefusalMessage(provider)}</p>
      </div>
    );
  }

  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={approved}
        onChange={(e) => onApprovedChange(e.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span>
        <span className="text-sm text-text-secondary">
          Approve the {APPROVED_PROVIDER_LABEL} for email, ticket and task content
        </span>
        <span className="block text-xs text-text-tertiary mt-0.5">
          AI stays off until you approve it. Velo sends only subjects, message text, status and
          priority, and logs every request locally.
        </span>
      </span>
    </label>
  );
}
