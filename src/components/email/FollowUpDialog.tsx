import type { RefObject } from "react";
import { Popover } from "@/components/ui/Popover";
import { QuickSchedulePicker, type ScheduleChoice } from "@/components/ui/QuickSchedulePicker";

interface FollowUpDialogProps {
  isOpen?: boolean;
  onSetReminder: (remindAt: number) => void;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}

function getFollowUpPresets(): ScheduleChoice[] {
  const now = new Date();
  const at = (days: number) => {
    const next = new Date(now);
    next.setDate(next.getDate() + days);
    next.setHours(8, 0, 0, 0);
    return Math.floor(next.getTime() / 1000);
  };
  return [
    { label: "In 1 day", timestamp: at(1) },
    { label: "In 2 days", timestamp: at(2) },
    { label: "In 3 days", timestamp: at(3) },
    { label: "In 1 week", timestamp: at(7) },
  ];
}

export function FollowUpDialog({ isOpen = true, onSetReminder, onClose, anchorRef }: FollowUpDialogProps) {
  if (!isOpen) return null;
  return (
    <Popover open onClose={onClose} title="Remind me if no reply..." anchorRef={anchorRef}>
      <QuickSchedulePicker presets={getFollowUpPresets()} onSelect={onSetReminder} submitLabel="Set reminder" />
    </Popover>
  );
}
