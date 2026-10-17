import { useEffect, useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { getHelpdeskConnection, getHelpdeskMetadataSummary } from "@/services/freshdesk/connection";
import type { HelpdeskAgent, HelpdeskGroup } from "@/services/freshdesk/metadata";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { useTicketEditor } from "./useTicketEditor";

const RECENTS = "velo-recent-agents";

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberAgent(id: string): void {
  const next = [id, ...readRecents().filter((item) => item !== id)].slice(0, 5);
  try {
    localStorage.setItem(RECENTS, JSON.stringify(next));
  } catch {
    // Private browsing can refuse storage.
  }
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** Properties, SLA, the requester and a searchable assignee. Group, tags and custom fields stay read-only: Freshdesk writes for them are not part of the edit contract yet. */
export function TicketInspector({
  ticket,
  onAssign,
}: {
  ticket: TicketListItem;
  onAssign: ReturnType<typeof useTicketEditor>["run"];
}) {
  const [agents, setAgents] = useState<HelpdeskAgent[]>([]);
  const [groups, setGroups] = useState<HelpdeskGroup[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getHelpdeskMetadataSummary(), getHelpdeskConnection()]).then(([summary, connection]) => {
      if (cancelled) return;
      setAgents(summary?.agents ?? []);
      setGroups(summary?.groups ?? []);
      setMeId(connection?.me?.agentId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [ticket.id]);

  const assign = (agent: HelpdeskAgent | null) => {
    if (agent) rememberAgent(agent.agentId);
    void onAssign({
      ticket,
      changes: { assigneeId: agent ? agent.agentId : null },
      shown: { assigneeId: agent ? agent.agentId : null, assignee: agent?.name ?? null },
      action: agent ? `Assign to ${agent.name}` : "Unassign",
      failure: `Assignee stays ${ticket.assignee ?? "unassigned"}`,
    });
  };

  const me = agents.find((agent) => agent.agentId === meId) ?? null;
  const recentIds = new Set(readRecents());
  const recent = agents.filter((agent) => recentIds.has(agent.agentId));
  const pinned: ComboboxOption[] = [
    ...(me ? [{ id: me.agentId, label: "Assign to me", detail: me.email ?? me.name }] : []),
    { id: "", label: "Unassigned" },
    ...recent.map((agent) => ({ id: agent.agentId, label: agent.name, detail: "Recent" })),
  ];
  const options: ComboboxOption[] = agents.map((agent) => ({
    id: agent.agentId,
    label: agent.name,
    detail: agent.email ?? undefined,
  }));

  const due = ticket.dueBy;
  const remaining = due === null ? null : due - Date.now();
  const overdue = remaining !== null && remaining < 0;
  const soon = remaining !== null && remaining >= 0 && remaining < 2 * 60 * 60 * 1000;
  const span = due === null ? 0 : Math.max(due - ticket.createdAt, 1);
  const progress = due === null ? 0 : Math.max(0, Math.min(1, (Date.now() - ticket.createdAt) / span));

  return (
    <aside aria-label="Ticket inspector" className="w-72 shrink-0 border-l border-separator bg-surface-subtle overflow-y-auto px-4 py-4 space-y-4">
      <section>
        <h3 className="text-meta text-text-tertiary mb-2">Properties</h3>
        <dl className="space-y-1 text-row">
          <Row label="Status" value={ticket.status.label ?? "Unknown"} />
          <Row label="Priority" value={ticket.priority?.label ?? "None"} />
          <Row label="Group" value={ticket.group?.name ?? "No group"} />
        </dl>
      </section>
      <section>
        <h3 className="text-meta text-text-tertiary mb-2">SLA</h3>
        {due === null ? (
          <p className="text-row text-text-secondary">No resolution time</p>
        ) : (
          <>
            <p className={`text-row ${overdue ? "text-status-error" : soon ? "text-status-warning" : "text-text-primary"}`}>
              {overdue ? "Overdue" : formatRemaining(remaining ?? 0)}
            </p>
            <div className="mt-1 h-1 rounded-full bg-separator">
              <div className={`h-1 rounded-full ${overdue ? "bg-status-error" : "bg-accent"}`} style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </>
        )}
      </section>
      <section aria-label="Requester">
        <h3 className="text-meta text-text-tertiary mb-2">Requester</h3>
        <p className="text-row font-medium text-text-primary">{ticket.customer ?? "Customer not loaded yet"}</p>
        {ticket.customerEmail && <p className="text-meta text-text-tertiary">{ticket.customerEmail}</p>}
      </section>
      <Combobox
        label="Assignee"
        options={options}
        pinned={pinned}
        value={ticket.assigneeId}
        placeholder="Search agents"
        onChange={(id) => {
          if (id === null) assign(null);
          else assign(agents.find((agent) => agent.agentId === id) ?? null);
        }}
      />
      {groups.length > 0 && (
        <label className="block text-meta text-text-tertiary">
          Group filter
          <select
            aria-label="Group filter"
            value={groupFilter ?? ""}
            onChange={(event) => setGroupFilter(event.target.value || null)}
            className="mt-1 w-full rounded-[var(--radius-control-sm)] border border-separator bg-surface-reader px-2 py-1 text-row text-text-primary"
          >
            <option value="">All groups</option>
            {groups.map((group) => (
              <option key={group.groupId} value={group.groupId}>{group.name}</option>
            ))}
          </select>
          <span className="block mt-1">Assigning a group stays in Freshdesk. The filter is a view of the groups on this helpdesk.</span>
        </label>
      )}
      <section>
        <h3 className="text-meta text-text-tertiary mb-2">Tags</h3>
        {ticket.tags.length === 0 ? (
          <p className="text-row text-text-tertiary">No tags</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {ticket.tags.map((tag) => (
              <span key={tag} className="rounded-full border border-separator px-2 py-0.5 text-meta text-text-secondary">{tag}</span>
            ))}
          </div>
        )}
      </section>
      <p className="text-meta text-text-tertiary">
        {initials(ticket.assignee ?? "Unassigned")} · Custom fields stay in Freshdesk.
      </p>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="text-text-primary text-right truncate">{value}</dd>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}
