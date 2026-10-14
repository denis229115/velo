import { useCallback, useEffect, useState } from "react";
import { FlaskConical, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { SampleBadge } from "@/components/ui/SampleBadge";
import type { StatusClass } from "@/services/db/freshdesk";
import {
  classifyStatus,
  connectHelpdesk,
  disconnectHelpdesk,
  getHelpdeskConnection,
  getHelpdeskMetadataSummary,
  getStatusClassification,
  refreshHelpdeskMetadata,
  type HelpdeskConnection,
  type HelpdeskMetadataSummary,
  type StatusClassification,
} from "@/services/freshdesk/connection";
import { SAMPLE_STATUSES, SAMPLE_TICKETS } from "@/services/freshdesk/sampleData";

const STATUS_CLASS_OPTIONS: { value: StatusClass; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "waiting", label: "Waiting" },
  { value: "done", label: "Done" },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function formatTimestamp(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "never";
}

export function FreshdeskSettings() {
  const [connection, setConnection] = useState<HelpdeskConnection | null>(null);
  const [classification, setClassification] = useState<StatusClassification | null>(null);
  const [summary, setSummary] = useState<HelpdeskMetadataSummary | null>(null);
  const [host, setHost] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nextConnection, nextClassification, nextSummary] = await Promise.all([
      getHelpdeskConnection(),
      getStatusClassification(),
      getHelpdeskMetadataSummary(),
    ]);
    setConnection(nextConnection);
    setClassification(nextClassification);
    setSummary(nextSummary);
  }, []);

  useEffect(() => {
    reload().catch((err) => setError(errorMessage(err)));
  }, [reload]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      await reload().catch(() => {});
      setBusy(false);
    }
  };

  const handleConnect = () =>
    run(async () => {
      await connectHelpdesk({ host, apiKey });
      setApiKey("");
    });

  const handleDisconnect = () =>
    run(async () => {
      await disconnectHelpdesk();
      setHost("");
      setApiKey("");
    });

  const handleClassify = (statusId: string, value: string) => {
    if (!value) return;
    void run(() => classifyStatus(statusId, value as StatusClass));
  };

  const isSample = classification?.isSample ?? true;

  return (
    <>
      <Section title="Helpdesk">
        {connection ? (
          <div className="space-y-3">
            <div>
              <p className="text-sm text-text-primary">Connected to {connection.host}</p>
              {connection.me && (
                <p className="text-xs text-text-tertiary mt-0.5">
                  Signed in as {connection.me.name}
                  {connection.me.email ? ` (${connection.me.email})` : ""}, agent ID {connection.me.agentId}
                </p>
              )}
              <p className="text-xs text-text-tertiary mt-0.5">
                Metadata last read {formatTimestamp(connection.metadataRefreshedAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="md" disabled={busy} onClick={() => run(refreshHelpdeskMetadata)}>
                <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
                Refresh metadata
              </Button>
              <Button variant="danger" size="md" disabled={busy} onClick={handleDisconnect}>
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-2 p-3 rounded-md border border-warning/40 bg-warning/10">
              <FlaskConical size={14} className="text-warning shrink-0 mt-0.5" />
              <p className="text-xs text-text-secondary">
                No helpdesk connected. The statuses and tickets below are sample data, not your helpdesk.
              </p>
            </div>
            <TextField
              label="Helpdesk address"
              size="md"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="yourcompany.freshdesk.com"
              autoComplete="off"
            />
            <TextField
              label="API key"
              size="md"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="From your Freshdesk profile settings"
              autoComplete="off"
            />
            <p className="text-xs text-text-tertiary">The API key is stored encrypted on this Mac.</p>
            <Button
              variant="primary"
              size="md"
              disabled={busy || !host.trim() || !apiKey.trim()}
              onClick={handleConnect}
            >
              {busy ? "Connecting..." : "Connect"}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </Section>

      <Section title="Status classes">
        <p className="text-xs text-text-tertiary">
          Classify each status: Open means we are expected to act, Waiting means the ball is in someone
          else's court, Done means no further work is expected.
        </p>
        {classification && (
          <table aria-label="Status classes" className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-tertiary">
                <th className="font-medium py-1.5">Status</th>
                <th className="font-medium py-1.5">ID</th>
                <th className="font-medium py-1.5">Class</th>
              </tr>
            </thead>
            <tbody>
              {classification.statuses.map((status) => (
                <tr key={status.id} className="border-t border-border-primary">
                  <td className="py-1.5 text-text-primary">
                    <span className="inline-flex items-center gap-2">
                      {status.label}
                      {isSample && <SampleBadge />}
                    </span>
                  </td>
                  <td className="py-1.5 text-text-tertiary tabular-nums">{status.id}</td>
                  <td className="py-1.5">
                    <select
                      aria-label={`Status class for ${status.label}`}
                      value={status.statusClass ?? ""}
                      disabled={busy}
                      onChange={(e) => handleClassify(status.id, e.target.value)}
                      className="bg-bg-tertiary text-text-primary text-sm px-2 py-1 rounded-md border border-border-primary focus:border-accent outline-none"
                    >
                      <option value="" disabled>
                        Not classified
                      </option>
                      {STATUS_CLASS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {connection && summary && (
        <Section title="Helpdesk metadata">
          <ul className="text-xs text-text-secondary space-y-1">
            <li>Priorities: {summary.priorities.map((p) => p.label).join(", ") || "none"}</li>
            <li>Groups: {summary.groups.map((g) => g.name).join(", ") || "none"}</li>
            <li>Agents: {summary.agents.length}</li>
            <li>Ticket fields: {summary.ticketFields.length}</li>
          </ul>
        </Section>
      )}

      {isSample && (
        <Section title="Sample tickets">
          <ul aria-label="Sample tickets" className="space-y-1.5">
            {SAMPLE_TICKETS.map((ticket) => (
              <li key={ticket.id} className="flex items-center gap-2 text-sm text-text-secondary">
                <SampleBadge />
                <span className="text-text-primary">{ticket.subject}</span>
                <span className="text-text-tertiary">
                  {ticket.customerName} · {SAMPLE_STATUSES.find((s) => s.id === ticket.statusId)?.label}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
