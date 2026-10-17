import type { RefObject } from "react";
import { Popover } from "@/components/ui/Popover";
import { QuickSchedulePicker, type ScheduleChoice } from "@/components/ui/QuickSchedulePicker";

interface SnoozeDialogProps {
  isOpen?: boolean;
  onSnooze: (until: number) => void;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}

function getSnoozePresets(): ScheduleChoice[] {
  const now = new Date();
  const today = new Date(now);

  const laterToday = new Date(now);
  if (now.getHours() < 14) {
    laterToday.setHours(17, 0, 0, 0);
  } else {
    laterToday.setTime(now.getTime() + 3 * 60 * 60 * 1000);
  }

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);

  const weekend = new Date(today);
  const dayOfWeek = weekend.getDay();
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7;
  weekend.setDate(weekend.getDate() + daysUntilSaturday);
  weekend.setHours(9, 0, 0, 0);

  const nextWeek = new Date(today);
  const daysUntilMonday = (1 - dayOfWeek + 7) % 7 || 7;
  nextWeek.setDate(nextWeek.getDate() + daysUntilMonday);
  nextWeek.setHours(8, 0, 0, 0);

  return [
    { label: "Later Today", timestamp: Math.floor(laterToday.getTime() / 1000) },
    { label: "Tomorrow", timestamp: Math.floor(tomorrow.getTime() / 1000) },
    { label: "This Weekend", timestamp: Math.floor(weekend.getTime() / 1000) },
    { label: "Next Week", timestamp: Math.floor(nextWeek.getTime() / 1000) },
  ];
}

export function SnoozeDialog({ isOpen = true, onSnooze, onClose, anchorRef }: SnoozeDialogProps) {
  if (!isOpen) return null;
  return (
    <Popover open onClose={onClose} title="Snooze until..." anchorRef={anchorRef}>
      <QuickSchedulePicker presets={getSnoozePresets()} onSelect={onSnooze} submitLabel="Snooze" />
    </Popover>
  );
}
