import { useEffect, useState } from "react";
import { getSetting, setSetting } from "@/services/db/settings";
import { AUTO_SUMMARY_SETTING } from "@/services/freshdesk/ticketAutoSummary";

/**
 * Settings → AI: whether the AI summary of the open ticket updates by itself
 * when a new public message arrives. On by default.
 */
export function TicketSummaryAutoUpdate() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSetting(AUTO_SUMMARY_SETTING)
      .then((v) => !cancelled && setOn(v !== "false"))
      .catch(() => !cancelled && setOn(true));
    return () => {
      cancelled = true;
    };
  }, []);

  if (on === null) return null;

  async function toggle() {
    const next = !on;
    setOn(next);
    await setSetting(AUTO_SUMMARY_SETTING, next ? "true" : "false");
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <span id="ticket-summary-auto-update" className="text-sm text-text-secondary">Update summaries automatically</span>
        <p className="text-xs text-text-tertiary mt-0.5">
          Refresh the AI summary of the open ticket when a new public message arrives. Internal notes never do. It follows the same send rules as Summarize: if an update needs your send preview, it waits for you.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby="ticket-summary-auto-update"
        onClick={() => void toggle()}
        className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ml-4 ${on ? "bg-accent" : "bg-bg-tertiary"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow ${on ? "translate-x-5" : ""}`} />
      </button>
    </div>
  );
}
