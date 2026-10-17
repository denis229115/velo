import { useId } from "react";
import { useTicketStore } from "@/stores/ticketStore";
import { useUIStore } from "@/stores/uiStore";
import { SAMPLE_MESSAGE } from "@/services/freshdesk/ticketEdits";

/** Why a Freshdesk write control is off while there is no connection to Freshdesk */
export const NEEDS_CONNECTION_REASON = "Needs a connection to Freshdesk";

export interface FreshdeskWritable {
  writable: boolean;
  /** Why writes are off, in the operator's words; null when they are on */
  reason: string | null;
  /** The id of the element {@link FreshdeskWriteReason} renders, for aria-describedby */
  reasonId: string;
  /** Spread on any control that writes to Freshdesk (button, select, menu trigger) */
  controlProps: { disabled: boolean; title?: string; "aria-describedby"?: string };
}

/**
 * Whether the operator may change anything in Freshdesk right now. Tickets are
 * shared with colleagues, so a write is never queued. While online, the ticket
 * list shows the change at once and rolls it back if Freshdesk refuses it.
 * While the app is offline, or the helpdesk connection is known to be down
 * (unreachable or rejecting the saved key), every write control is disabled and
 * says why. Every Freshdesk write control takes its state from here, so it
 * re-enables on reconnect without a reload.
 */
export function useFreshdeskWritable(options: { isSample?: boolean } = {}): FreshdeskWritable {
  const reasonId = useId();
  const isOnline = useUIStore((s) => s.isOnline);
  const syncState = useTicketStore((s) => s.data?.sync.state);
  const sampleList = useTicketStore((s) => s.data?.isSample ?? false);
  const helpdeskDown = syncState === "error" || syncState === "auth_error";
  const reason = options.isSample || sampleList ? SAMPLE_MESSAGE : !isOnline || helpdeskDown ? NEEDS_CONNECTION_REASON : null;
  return {
    writable: reason === null,
    reason,
    reasonId,
    controlProps:
      reason === null ? { disabled: false } : { disabled: true, title: reason, "aria-describedby": reasonId },
  };
}

/** The visible reason write controls are off; renders nothing while writes are allowed */
export function FreshdeskWriteReason({ writable, className = "text-meta text-text-tertiary" }: { writable: FreshdeskWritable; className?: string }) {
  if (writable.reason === null) return null;
  return (
    <p id={writable.reasonId} role="status" className={className}>
      {writable.reason}
    </p>
  );
}
