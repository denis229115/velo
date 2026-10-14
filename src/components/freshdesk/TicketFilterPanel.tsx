import { useEffect, useMemo, useState } from "react";
import { getHelpdeskMetadataSummary, getStatusClassification, type HelpdeskMetadataSummary, type StatusClassification } from "@/services/freshdesk/connection";
import type { StatusClassFilter, TicketViewFilter } from "@/services/freshdesk/ticketViews";
import type { TicketListData } from "@/services/freshdesk/ticketSync";
import { selectCurrentView, useTicketStore } from "@/stores/ticketStore";

interface Choice {
  value: string;
  label: string;
  /** Accessible name when the visible label alone is ambiguous */
  name?: string;
}

type ListField = "statusIds" | "statusClasses" | "assignees" | "groupIds" | "priorityIds" | "companyIds" | "tags";

const STATUS_CLASSES: { value: StatusClassFilter; label: string }[] = [
  { value: "outstanding", label: "Outstanding" },
  { value: "open", label: "Open" },
  { value: "waiting", label: "Waiting" },
  { value: "done", label: "Done" },
];

function ChoiceGroup({ legend, choices, selected, onToggle }: { legend: string; choices: Choice[]; selected: string[]; onToggle: (value: string) => void }) {
  if (choices.length === 0) return null;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-micro font-medium uppercase tracking-wider text-text-tertiary">{legend}</legend>
      <div className="flex flex-wrap gap-1">
        {choices.map((c) => {
          const checked = selected.includes(c.value);
          return (
            <label
              key={c.value}
              className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-meta transition-colors ${
                checked ? "border-accent/50 bg-accent/10 text-accent" : "border-border-primary text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <input type="checkbox" className="sr-only" checked={checked} onChange={() => onToggle(c.value)} aria-label={c.name ?? c.label} />
              {c.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const unique = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null))].sort();

/** Status, assignee, group, priority, company, tags, dates and needs-reply; AND across fields, OR within one. */
export function TicketFilterPanel({ data, onClose }: { data: TicketListData | null; onClose: () => void }) {
  const view = useTicketStore(selectCurrentView);
  const draft = useTicketStore((s) => s.draftFilter);
  const setDraftFilter = useTicketStore((s) => s.setDraftFilter);
  const saveViewAs = useTicketStore((s) => s.saveViewAs);
  const updateView = useTicketStore((s) => s.updateView);
  const [classification, setClassification] = useState<StatusClassification | null>(null);
  const [metadata, setMetadata] = useState<HelpdeskMetadataSummary | null>(null);
  const [name, setName] = useState("");
  const filter = draft ?? view.filter;

  useEffect(() => {
    void getStatusClassification().then(setClassification);
    void getHelpdeskMetadataSummary().then(setMetadata);
  }, []);

  const tickets = useMemo(() => data?.tickets ?? [], [data]);
  const statuses = useMemo<Choice[]>(() => {
    const known = (classification?.statuses ?? []).map((s) => ({ value: s.id, label: s.label }));
    const unknown = unique(tickets.filter((t) => !t.status.known).map((t) => t.status.id)).map((id) => ({ value: id, label: `Unknown status ${id}` }));
    return [...known, ...unknown];
  }, [classification, tickets]);
  const priorities = metadata
    ? metadata.priorities.map((p) => ({ value: p.choiceId, label: p.label }))
    : unique(tickets.map((t) => t.priority?.id ?? null)).map((id) => ({ value: id, label: tickets.find((t) => t.priority?.id === id)?.priority?.label ?? id }));
  const assignees: Choice[] = [
    ...(data?.meAgentId ? [{ value: "me", label: "Me" }] : []),
    { value: "unassigned", label: "Unassigned" },
    ...(metadata?.agents ?? []).filter((a) => a.agentId !== data?.meAgentId).map((a) => ({ value: a.agentId, label: a.name })),
  ];
  const groups = (metadata?.groups ?? []).map((g) => ({ value: g.groupId, label: g.name }));
  const companies = unique(tickets.map((t) => t.companyId)).map((id) => ({ value: id, label: `Company ${id}` }));
  const tags = unique(tickets.flatMap((t) => t.tags)).map((tag) => ({ value: tag, label: tag }));

  const change = (next: TicketViewFilter) => setDraftFilter(next);
  const toggle = (field: ListField, value: string) => {
    const current = (filter[field] ?? []) as string[];
    const values = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    const { [field]: _removed, ...rest } = filter;
    change(values.length ? { ...rest, [field]: values } : rest);
  };
  const group = (legend: string, field: ListField, choices: Choice[]) => (
    <ChoiceGroup legend={legend} choices={choices} selected={(filter[field] ?? []) as string[]} onToggle={(v) => toggle(field, v)} />
  );

  const save = async () => {
    if (!name.trim()) return;
    await saveViewAs(name.trim());
    setName("");
    onClose();
  };

  return (
    <section aria-label="Filters" className="space-y-2.5 border-b border-border-primary bg-bg-secondary/60 px-3 py-2.5">
      {group("Status class", "statusClasses", STATUS_CLASSES.map((c) => ({ ...c, name: `${c.label} (status class)` })))}
      {group("Status", "statusIds", statuses)}
      {group("Assignee", "assignees", assignees)}
      {group("Group", "groupIds", groups)}
      {group("Priority", "priorityIds", priorities)}
      {group("Company", "companyIds", companies)}
      {group("Tags", "tags", tags)}
      <div className="flex flex-wrap items-center gap-2 text-meta text-text-secondary">
        <label className="inline-flex items-center gap-1">
          Needs reply
          <select
            aria-label="Needs reply"
            value={filter.needsReply === undefined ? "any" : filter.needsReply ? "yes" : "no"}
            onChange={(e) => {
              const { needsReply: _n, ...rest } = filter;
              change(e.target.value === "any" ? rest : { ...rest, needsReply: e.target.value === "yes" });
            }}
            className="rounded-md border border-border-primary bg-bg-primary px-1 py-0.5"
          >
            <option value="any">Any</option>
            <option value="yes">Needs reply</option>
            <option value="no">Does not need reply</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1">
          <select
            aria-label="Date field"
            value={filter.dates?.field ?? "updated"}
            onChange={(e) => filter.dates && change({ ...filter, dates: { ...filter.dates, field: e.target.value as "created" | "updated" } })}
            className="rounded-md border border-border-primary bg-bg-primary px-1 py-0.5"
          >
            <option value="updated">Updated</option>
            <option value="created">Created</option>
          </select>
          within
          <input
            type="number"
            min={1}
            aria-label="Within days"
            value={filter.dates?.withinDays ?? ""}
            onChange={(e) => {
              const days = Number(e.target.value);
              const { dates: _d, ...rest } = filter;
              change(days > 0 ? { ...rest, dates: { field: filter.dates?.field ?? "updated", withinDays: days } } : rest);
            }}
            className="w-14 rounded-md border border-border-primary bg-bg-primary px-1 py-0.5"
          />
          days
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <input
          type="text"
          aria-label="View name"
          placeholder="New view name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          className="min-w-0 flex-1 rounded-md border border-border-primary bg-bg-primary px-2 py-1 text-meta"
        />
        <button type="button" onClick={() => void save()} disabled={!name.trim()} className="rounded-md bg-accent px-2 py-1 text-meta font-medium text-white disabled:opacity-50">
          Save as view
        </button>
        {view.kind === "custom" && draft && (
          <button
            type="button"
            onClick={() => void updateView(view.id, { filter: draft }).then(() => setDraftFilter(null))}
            className="rounded-md border border-border-primary px-2 py-1 text-meta text-text-primary hover:bg-bg-hover"
          >
            Save filters
          </button>
        )}
        {draft && (
          <button type="button" onClick={() => setDraftFilter(null)} className="rounded-md px-2 py-1 text-meta text-text-secondary hover:bg-bg-hover">
            Reset
          </button>
        )}
      </div>
    </section>
  );
}
