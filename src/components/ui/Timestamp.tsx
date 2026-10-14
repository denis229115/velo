import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUIStore } from "@/stores/uiStore";
import { formatDateOnly, formatExact, formatRelative, systemTimeZone } from "@/utils/timeZone";

/** The zone times are shown in: the operator's override, else the Mac's zone. */
export function useDisplayTimeZone(): string {
  return useUIStore((s) => s.timeZoneOverride) ?? systemTimeZone();
}

const TOOLTIP_MARGIN = 8;

function ZoneTooltip({ id, anchor, at, zones }: { id: string; anchor: HTMLElement; at: number; zones: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Below the time, flipped above near the bottom edge and kept inside the window sideways
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const tip = ref.current?.getBoundingClientRect();
    const width = tip?.width ?? 0;
    const height = tip?.height ?? 0;
    const left = Math.max(TOOLTIP_MARGIN, Math.min(box.left, window.innerWidth - width - TOOLTIP_MARGIN));
    const below = box.bottom + 4;
    const top = below + height > window.innerHeight - TOOLTIP_MARGIN ? Math.max(TOOLTIP_MARGIN, box.top - height - 4) : below;
    setPos({ left, top });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className="fixed z-50 pointer-events-none rounded-md border border-border-primary bg-surface-overlay shadow-lg px-2.5 py-1.5 text-meta text-text-primary"
    >
      <table>
        <tbody>
          {zones.map((zone, i) => (
            <tr key={zone}>
              <td className={`pr-3 whitespace-nowrap ${i === 0 ? "text-text-primary" : "text-text-secondary"}`}>
                {formatExact(at, zone)}
              </td>
              <td className="whitespace-nowrap text-text-tertiary">{zone}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}

/**
 * An instant shown relative to now; hovering or focusing it shows the exact
 * time in the display zone and in each extra zone from Settings.
 */
export function Timestamp({ at, className, focusable = true }: { at: number; className?: string; focusable?: boolean }) {
  const zone = useDisplayTimeZone();
  const extra = useUIStore((s) => s.extraTimeZones);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const id = useId();
  const zones = [...new Set([zone, ...extra])];

  const show = (e: { currentTarget: HTMLElement }) => setAnchor(e.currentTarget);
  const hide = () => setAnchor(null);

  return (
    <>
      <time
        dateTime={new Date(at).toISOString()}
        tabIndex={focusable ? 0 : undefined}
        aria-describedby={anchor ? id : undefined}
        aria-label={formatExact(at, zone)}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={`tabular-nums rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${className ?? ""}`}
      >
        {formatRelative(at, Date.now(), zone)}
      </time>
      {anchor && <ZoneTooltip id={id} anchor={anchor} at={at} zones={zones} />}
    </>
  );
}

/** A calendar date (YYYY-MM-DD) such as a date-only deadline; never shifted by time zone. */
export function DateOnly({ value, className }: { value: string; className?: string }) {
  return (
    <time dateTime={value} className={className}>
      {formatDateOnly(value) ?? value}
    </time>
  );
}
