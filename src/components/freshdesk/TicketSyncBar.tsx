import { CircleAlert, Clock, TriangleAlert } from "lucide-react";
import type { TicketListData, TicketSyncStatus } from "@/services/freshdesk/ticketSync";
import { SampleBadge } from "@/components/ui/SampleBadge";
import { navigateToSettings } from "@/router/navigate";

export function formatAgo(ms: number, now = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** What the local ticket copy covers, never a helpdesk-wide total. */
export function coverageText(sync: TicketSyncStatus): string {
  if (sync.coverage.outstandingTotal === null) return "coverage unknown until the first full sync";
  if (sync.coverage.complete) return "all outstanding + 90 days of done";
  return `partial: ${sync.coverage.outstandingDownloaded ?? 0} of ${sync.coverage.outstandingTotal} outstanding`;
}

const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Coverage and freshness of the local ticket copy, so a partial or old list is never mistaken for the helpdesk. */
export function TicketSyncBar({ data }: { data: TicketListData }) {
  if (data.isSample) {
    return (
      <div className="flex items-center gap-2 px-4 py-1.5 text-meta text-text-secondary border-b border-border-secondary">
        <SampleBadge />
        <span>Sample data. Connect a helpdesk in Settings → Freshdesk to see real tickets.</span>
      </div>
    );
  }

  const { sync } = data;
  const downloaded = data.tickets.length;
  // Partial or unknown coverage is stated once, in the Partial results bar under this line
  const coverage = sync.coverage.complete ? coverageText(sync) : null;

  const freshness =
    sync.lastSuccessAt === null ? "Not synced yet" : `Last synced ${formatAgo(sync.lastSuccessAt)}`;

  return (
    <div className="border-b border-border-secondary">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-1.5 text-meta text-text-secondary">
        <span>
          {downloaded} downloaded{coverage && ` · ${coverage}`}
        </span>
        <span className="flex items-center gap-1">
          {sync.stale && (
            <span className="inline-flex items-center gap-1 font-medium text-status-warning">
              <Clock size={11} aria-hidden />
              Stale ·
            </span>
          )}
          {freshness}
        </span>
      </div>
      {sync.state === "rate_limited" && (
        <p role="status" className="flex items-center gap-1.5 px-4 pb-1.5 text-meta text-status-warning">
          <Clock size={12} aria-hidden className="shrink-0" />
          {sync.message}
          {sync.retryAt !== null && ` Next try at ${timeOfDay(sync.retryAt)}.`}
        </p>
      )}
      {sync.state === "error" && (
        <p role="status" className="flex items-center gap-1.5 px-4 pb-1.5 text-meta text-status-error">
          <CircleAlert size={12} aria-hidden className="shrink-0" />
          {sync.message}
          {sync.retryAt !== null && ` Next try at ${timeOfDay(sync.retryAt)}.`}
        </p>
      )}
      {sync.state === "auth_error" && (
        <div role="alert" className="flex items-start gap-2 px-4 pb-2 text-meta text-status-error">
          <TriangleAlert size={13} aria-hidden className="shrink-0 mt-px" />
          <span className="flex-1">{sync.message}</span>
          <button
            type="button"
            onClick={() => navigateToSettings("freshdesk")}
            className="shrink-0 font-medium underline underline-offset-2 hover:text-text-primary"
          >
            Open settings
          </button>
        </div>
      )}
    </div>
  );
}
