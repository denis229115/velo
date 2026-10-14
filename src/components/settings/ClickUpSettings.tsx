import { useCallback, useEffect, useState } from "react";
import { FlaskConical, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { SampleBadge } from "@/components/ui/SampleBadge";
import {
  connectWorkspace,
  disconnectWorkspace,
  getClickUpSettings,
  refreshWorkspaceMetadata,
  setDefaultList,
  setTicketIdField,
  type ClickUpSettingsView,
} from "@/services/clickup/connection";
import type { ClickUpWorkspaceRef } from "@/services/clickup/metadata";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function formatTimestamp(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toLocaleString() : "never";
}

const SELECT_CLASS =
  "bg-bg-tertiary text-text-primary text-sm px-2 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none w-full max-w-sm";

export function ClickUpSettings() {
  const [settings, setSettings] = useState<ClickUpSettingsView | null>(null);
  const [token, setToken] = useState("");
  const [choices, setChoices] = useState<ClickUpWorkspaceRef[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setSettings(await getClickUpSettings()), []);

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
      const result = await connectWorkspace({ token, workspaceId: workspaceId || undefined });
      if (result.status === "choose_workspace") {
        setChoices(result.workspaces);
        setWorkspaceId(result.workspaces[0]?.workspaceId ?? "");
        return;
      }
      setToken("");
      setChoices(null);
      setWorkspaceId("");
    });

  const handleDisconnect = () =>
    run(async () => {
      await disconnectWorkspace();
      setToken("");
    });

  const workspace = settings?.workspace ?? null;
  const isSample = settings?.isSample ?? true;

  return (
    <>
      <Section title="Workspace">
        {workspace ? (
          <div className="space-y-3">
            <div>
              <p className="text-sm text-text-primary">Connected to {workspace.name}</p>
              {workspace.me && (
                <p className="text-xs text-text-tertiary mt-0.5">
                  Signed in as {workspace.me.name}
                  {workspace.me.email ? ` (${workspace.me.email})` : ""}
                </p>
              )}
              <p className="text-xs text-text-tertiary mt-0.5">
                Lists and fields last read {formatTimestamp(workspace.metadataRefreshedAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="md" disabled={busy} onClick={() => run(refreshWorkspaceMetadata)}>
                <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
                Refresh lists and fields
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
                No workspace connected. The lists below are sample data, not your workspace.
              </p>
            </div>
            <TextField
              label="API token"
              size="md"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Personal token from ClickUp → Settings → Apps"
              autoComplete="off"
            />
            {choices && (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-text-secondary">Workspace</span>
                <select
                  aria-label="Workspace"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {choices.map((w) => (
                    <option key={w.workspaceId} value={w.workspaceId}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-xs text-text-tertiary">The token is stored encrypted on this Mac.</p>
            <Button variant="primary" size="md" disabled={busy || !token.trim()} onClick={handleConnect}>
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

      {settings && !isSample && (
        <Section title="Defaults">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-text-secondary">Default list</span>
            <select
              aria-label="Default list"
              value={settings.defaultListId ?? ""}
              disabled={busy}
              onChange={(e) => void run(() => setDefaultList(e.target.value || null))}
              className={SELECT_CLASS}
            >
              <option value="">No default list</option>
              {settings.lists.map((l) => (
                <option key={l.listId} value={l.listId}>
                  {l.name} ({l.location})
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-text-secondary">Ticket-ID field</span>
            <select
              aria-label="Ticket-ID field"
              value={settings.ticketIdFieldId ?? ""}
              disabled={busy}
              onChange={(e) => void run(() => setTicketIdField(e.target.value || null))}
              className={SELECT_CLASS}
            >
              <option value="">Not selected</option>
              {settings.customFields.map((f) => (
                <option key={f.fieldId} value={f.fieldId}>
                  {f.name} ({f.type})
                </option>
              ))}
            </select>
            <span className="block text-xs text-text-tertiary">
              Create a custom field for the ticket ID in ClickUp, then refresh lists and fields and select it here.
            </span>
          </label>
        </Section>
      )}

      {settings && (
        <Section title="Lists">
          <ul aria-label="Lists" className="space-y-2">
            {settings.lists.map((l) => (
              <li key={l.listId} className="text-sm">
                <span className="inline-flex items-center gap-2">
                  <span className="text-text-primary">{l.name}</span>
                  {isSample && <SampleBadge />}
                  <span className="text-xs text-text-tertiary">{l.location}</span>
                </span>
                <p className="text-xs text-text-secondary mt-0.5">
                  Statuses: {l.statuses.map((s) => s.name).join(", ") || "none"}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {settings && !isSample && (
        <Section title="Members and custom fields">
          <ul className="text-xs text-text-secondary space-y-1">
            <li>Members: {settings.members.map((m) => m.name).join(", ") || "none"}</li>
            <li>
              Custom fields:{" "}
              {settings.customFields.map((f) => `${f.name} (${f.listNames.join(", ")})`).join("; ") || "none"}
            </li>
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
