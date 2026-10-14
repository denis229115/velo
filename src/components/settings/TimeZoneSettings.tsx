import { useMemo } from "react";
import { X } from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { supportedTimeZones, systemTimeZone } from "@/utils/timeZone";

const SELECT_CLASS =
  "w-56 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none";

/** Settings → General → Time: the display zone and the extra zones shown when hovering a time. */
export function TimeZoneSettings() {
  const override = useUIStore((s) => s.timeZoneOverride);
  const setOverride = useUIStore((s) => s.setTimeZoneOverride);
  const extra = useUIStore((s) => s.extraTimeZones);
  const setExtra = useUIStore((s) => s.setExtraTimeZones);
  const zones = useMemo(() => supportedTimeZones(), []);
  const system = systemTimeZone();

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-3">Time</h3>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label htmlFor="time-zone-override" className="text-sm text-text-secondary">
            Show times in
          </label>
          <select
            id="time-zone-override"
            value={override ?? ""}
            onChange={(e) => setOverride(e.target.value || null)}
            className={SELECT_CLASS}
          >
            <option value="">Mac time zone ({system})</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-text-secondary">Also show on hover</p>
            <p className="text-xs text-text-tertiary">Hovering a time shows it in these zones too.</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <ul aria-label="Extra time zones" className="flex flex-wrap justify-end gap-1.5 max-w-56">
              {extra.map((z) => (
                <li
                  key={z}
                  className="inline-flex items-center gap-1 rounded-md border border-border-primary bg-surface-subtle pl-2 pr-1 py-0.5 text-xs text-text-primary"
                >
                  {z}
                  <button
                    type="button"
                    aria-label={`Remove ${z}`}
                    onClick={() => setExtra(extra.filter((x) => x !== z))}
                    className="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
            <select
              aria-label="Add a time zone"
              value=""
              onChange={(e) => e.target.value && setExtra([...extra, e.target.value])}
              className={SELECT_CLASS}
            >
              <option value="">Add a time zone…</option>
              {zones.filter((z) => !extra.includes(z)).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
