import { useEffect, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { getFieldChoices, getTicketFields } from "@/services/db/freshdesk";
import { getHelpdeskConnection, getHelpdeskMetadataSummary } from "@/services/freshdesk/connection";
import type { FieldChoice, HelpdeskAgent, HelpdeskGroup, TicketFieldDefinition } from "@/services/freshdesk/metadata";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { useTicketEditor } from "./useTicketEditor";
import { FreshdeskWriteReason, useFreshdeskWritable } from "./useFreshdeskWritable";

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

interface FieldMeta {
  typeChoices: FieldChoice[];
  custom: TicketFieldDefinition[];
  choices: Record<string, FieldChoice[]>;
}

const EMPTY_FIELDS: FieldMeta = { typeChoices: [], custom: [], choices: {} };

/** Properties, SLA, requester, assignee, and the Freshdesk fields Velo can change. */
export function TicketInspector({
  ticket,
  onEdit,
}: {
  ticket: TicketListItem;
  onEdit: ReturnType<typeof useTicketEditor>["run"];
}) {
  const [agents, setAgents] = useState<HelpdeskAgent[]>([]);
  const [groups, setGroups] = useState<HelpdeskGroup[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldMeta>(EMPTY_FIELDS);
  const writable = useFreshdeskWritable({ isSample: ticket.isSample });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [summary, connection] = await Promise.all([getHelpdeskMetadataSummary(), getHelpdeskConnection()]);
      if (cancelled) return;
      setAgents(summary?.agents ?? []);
      setGroups(summary?.groups ?? []);
      setMeId(connection?.me?.agentId ?? null);
      if (!connection) {
        setFields(EMPTY_FIELDS);
        return;
      }
      const definitions = await getTicketFields(connection.tenantId);
      const typeField = definitions.find((field) => field.name === "ticket_type" || field.name === "type");
      const custom = definitions.filter((field) => !field.isDefault && field.name.startsWith("cf_"));
      const named = [typeField, ...custom].filter((field): field is TicketFieldDefinition => field !== undefined);
      const loaded = await Promise.all(named.map(async (field) => [field.name, await getFieldChoices(connection.tenantId, field.name)] as const));
      if (cancelled) return;
      const choices = Object.fromEntries(loaded);
      setFields({
        typeChoices: typeField ? (choices[typeField.name] ?? []) : [],
        custom,
        choices,
      });
    })().catch(() => {
      if (!cancelled) setFields(EMPTY_FIELDS);
    });
    return () => {
      cancelled = true;
    };
  }, [ticket.id]);

  const assign = (agent: HelpdeskAgent | null) => {
    if (agent) rememberAgent(agent.agentId);
    void onEdit({
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
      <p className="text-row font-medium text-text-primary break-words">{ticket.subject || "(no subject)"}</p>
      <FreshdeskWriteReason writable={writable} />
      <section>
        <h3 className="text-meta text-text-tertiary mb-2">Properties</h3>
        <dl className="space-y-2 text-row">
          <Row label="Status" value={ticket.status.label ?? "Unknown"} />
          <Row label="Priority" value={ticket.priority?.label ?? "None"} />
          <ChoiceRow
            label="Group"
            value={ticket.group?.id ?? ""}
            empty="No group"
            options={[{ value: "", label: "No group" }, ...groups.map((group) => ({ value: group.groupId, label: group.name }))]}
            disabled={!writable.writable}
            describedBy={writable.controlProps["aria-describedby"]}
            onChange={(groupId) => {
              const group = groups.find((item) => item.groupId === groupId) ?? null;
              void onEdit({
                ticket,
                changes: { groupId: groupId || null },
                shown: { group: group ? { id: group.groupId, name: group.name } : null },
                action: group ? `Move to ${group.name}` : "Clear group",
                failure: `Group stays ${ticket.group?.name ?? "unset"}`,
              });
            }}
          />
          <ChoiceRow
            label="Type"
            value={ticket.ticketType ?? ""}
            empty="No type"
            options={[
              { value: "", label: "No type" },
              ...fields.typeChoices.map((choice) => ({ value: choice.label, label: choice.label })),
              ...(ticket.ticketType && !fields.typeChoices.some((choice) => choice.label === ticket.ticketType)
                ? [{ value: ticket.ticketType, label: ticket.ticketType }]
                : []),
            ]}
            disabled={!writable.writable}
            describedBy={writable.controlProps["aria-describedby"]}
            onChange={(ticketType) => {
              void onEdit({
                ticket,
                changes: { ticketType: ticketType || null },
                shown: { ticketType: ticketType || null },
                action: ticketType ? `Set type to ${ticketType}` : "Clear type",
                failure: `Type stays ${ticket.ticketType ?? "unset"}`,
              });
            }}
          />
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
      <TagEditor
        tags={ticket.tags}
        disabled={!writable.writable}
        describedBy={writable.controlProps["aria-describedby"]}
        onChange={(tags, action, failure) => {
          void onEdit({
            ticket,
            changes: { tags },
            shown: { tags },
            action,
            failure,
          });
        }}
      />
      {fields.custom.length > 0 && (
        <section aria-label="Custom fields">
          <h3 className="text-meta text-text-tertiary mb-2">Custom fields</h3>
          <div className="space-y-2">
            {fields.custom.map((field) => (
              <CustomField
                key={field.name}
                field={field}
                value={ticket.customFields[field.name] ?? ""}
                choices={fields.choices[field.name] ?? []}
                disabled={!writable.writable}
                describedBy={writable.controlProps["aria-describedby"]}
                onChange={(value) => {
                  const customFields = { ...ticket.customFields, [field.name]: value };
                  void onEdit({
                    ticket,
                    changes: { customFields: { [field.name]: value || null } },
                    shown: { customFields },
                    action: `Set ${field.label}`,
                    failure: `${field.label} stays ${ticket.customFields[field.name] || "unset"}`,
                  });
                }}
              />
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

const fieldClass =
  "mt-1 w-full rounded-[var(--radius-control-sm)] border border-separator bg-surface-reader px-2 py-1 text-row text-text-primary disabled:opacity-60";

function ChoiceRow({
  label,
  value,
  empty,
  options,
  disabled,
  describedBy,
  onChange,
}: {
  label: string;
  value: string;
  empty: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  const known = options.some((option) => option.value === value);
  const choices = known || value === "" ? options : [...options, { value, label: value }];
  return (
    <div>
      <dt className="text-text-tertiary">{label}</dt>
      <dd>
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={fieldClass}
        >
          {choices.map((option) => (
            <option key={option.value || empty} value={option.value}>{option.label}</option>
          ))}
        </select>
      </dd>
    </div>
  );
}

function TagEditor({
  tags,
  disabled,
  describedBy,
  onChange,
}: {
  tags: string[];
  disabled: boolean;
  describedBy?: string;
  onChange: (tags: string[], action: string, failure: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (disabled) return;
    const next = draft.trim();
    if (!next || tags.includes(next)) {
      setDraft("");
      return;
    }
    onChange([...tags, next], `Add tag ${next}`, "Tags stay unchanged");
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  };
  return (
    <section>
      <h3 className="text-meta text-text-tertiary mb-2">Tags</h3>
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-separator px-2 py-0.5 text-meta text-text-secondary">
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              disabled={disabled}
              aria-describedby={describedBy}
              onClick={() => onChange(tags.filter((item) => item !== tag), `Remove tag ${tag}`, "Tags stay unchanged")}
              className="text-text-tertiary hover:text-text-primary disabled:opacity-50"
            >
              <X size={11} aria-hidden />
            </button>
          </span>
        ))}
        {tags.length === 0 && <p className="text-row text-text-tertiary">No tags</p>}
      </div>
      <input
        aria-label="Add tag"
        value={draft}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder="Add a tag"
        className={fieldClass}
      />
    </section>
  );
}

function CustomField({
  field,
  value,
  choices,
  disabled,
  describedBy,
  onChange,
}: {
  field: TicketFieldDefinition;
  value: string;
  choices: FieldChoice[];
  disabled: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  if (choices.length > 0) {
    return (
      <label className="block text-meta text-text-tertiary">
        {field.label}
        <select
          aria-label={field.label}
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={fieldClass}
        >
          <option value="">None</option>
          {choices.map((choice) => (
            <option key={choice.choiceId} value={choice.label}>{choice.label}</option>
          ))}
        </select>
      </label>
    );
  }
  return <TextCustomField field={field} value={value} disabled={disabled} describedBy={describedBy} onChange={onChange} />;
}

function TextCustomField({
  field,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  field: TicketFieldDefinition;
  value: string;
  disabled: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onChange(draft);
  };
  return (
    <label className="block text-meta text-text-tertiary">
      {field.label}
      <input
        aria-label={field.label}
        value={draft}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className={fieldClass}
      />
    </label>
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
