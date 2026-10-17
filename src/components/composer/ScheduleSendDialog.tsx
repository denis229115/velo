import { useRef, type ReactNode, type RefObject } from "react";
import { Popover } from "@/components/ui/Popover";
import { QuickSchedulePicker } from "@/components/ui/QuickSchedulePicker";
import { buildSchedulePresets, presetFromDate, recipientMorning } from "@/utils/schedulePresets";

interface ScheduleSendDialogProps {
  onSchedule: (timestamp: number) => void;
  onClose: () => void;
  /** Defaults to scheduling an email */
  title?: string;
  note?: string;
  /** Options chosen before picking a time */
  children?: ReactNode;
  anchorRef?: RefObject<HTMLElement | null>;
  /** Minutes east of UTC, when the last inbound Date header had one. */
  recipientOffsetMinutes?: number | null;
  /** Display name for the morning preset. */
  recipientName?: string | null;
}

const EMAIL_NOTE =
  "Your email sends when Velo is next open at or after this time — not while your Mac sleeps or Velo is closed.";

export function ScheduleSendDialog({
  onSchedule,
  onClose,
  title = "Schedule send",
  note = EMAIL_NOTE,
  children,
  anchorRef,
  recipientOffsetMinutes = null,
  recipientName = null,
}: ScheduleSendDialogProps) {
  const fallbackRef = useRef<HTMLElement | null>(null);
  const now = new Date();
  const presets = buildSchedulePresets(now);
  if (recipientOffsetMinutes !== null) {
    const morning = recipientMorning(now, recipientOffsetMinutes);
    const who = recipientName?.trim() || "Recipient";
    presets.push(presetFromDate(morning, `${who}’s morning`, "recipient"));
  }

  return (
    <Popover open onClose={onClose} title={title} anchorRef={anchorRef ?? fallbackRef} width={340}>
      <QuickSchedulePicker
        presets={presets}
        onSelect={onSchedule}
        submitLabel="Schedule"
        note={note}
        recipientOffsetMinutes={recipientOffsetMinutes}
      >
        {children}
      </QuickSchedulePicker>
    </Popover>
  );
}
