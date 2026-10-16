import { useId } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useFreshdeskWritable, type FreshdeskWritable } from "@/components/freshdesk/useFreshdeskWritable";
import type { LinkedItem } from "@/services/clickup/links";

/** Why a ClickUp write control on an email thread is off */
export const CLICKUP_NEEDS_CONNECTION_REASON = "Needs a connection to ClickUp";

/**
 * Whether the operator may create, link or retry ClickUp tasks for the item
 * right now. Nothing is ever queued: offline, every such control is disabled
 * and says why. A ticket's task also writes an internal note, so it follows
 * the Freshdesk write state; an email thread writes only to ClickUp, so only
 * the connection counts.
 */
export function useClickUpWritable(item: LinkedItem): FreshdeskWritable {
  const ticket = useFreshdeskWritable();
  const reasonId = useId();
  const isOnline = useUIStore((s) => s.isOnline);
  if (item.kind === "ticket") return ticket;
  const reason = isOnline ? null : CLICKUP_NEEDS_CONNECTION_REASON;
  return {
    writable: reason === null,
    reason,
    reasonId,
    controlProps:
      reason === null ? { disabled: false } : { disabled: true, title: reason, "aria-describedby": reasonId },
  };
}
