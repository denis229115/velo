import { useEffect, useRef, useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { Menu } from "@/components/ui/Menu";
import { useTicketStore } from "@/stores/ticketStore";
import {
  getHelpdeskMetadataSummary,
  getStatusClassification,
  type ClassifiableStatus,
} from "@/services/freshdesk/connection";
import type { FieldChoice, HelpdeskAgent } from "@/services/freshdesk/metadata";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import { priorityAppearance, statusAppearance, TONES, type BadgeAppearance } from "./TicketBadges";
import type { useTicketEditor } from "./useTicketEditor";
import { useFreshdeskWritable, type FreshdeskWritable } from "./useFreshdeskWritable";

interface EditOptions {
  statuses: ClassifiableStatus[];
  priorities: FieldChoice[];
  agents: HelpdeskAgent[];
}

/** The helpdesk's statuses, priorities and agents, re-read with the ticket list */
function useEditOptions(): EditOptions {
  const version = useTicketStore((s) => s.version);
  const [options, setOptions] = useState<EditOptions>({ statuses: [], priorities: [], agents: [] });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([getStatusClassification(), getHelpdeskMetadataSummary()]).then(([classification, summary]) => {
      if (cancelled) return;
      setOptions({ statuses: classification.statuses, priorities: summary?.priorities ?? [], agents: summary?.agents ?? [] });
    });
    return () => {
      cancelled = true;
    };
  }, [version]);
  return options;
}

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

function EditSelect({
  labelledBy,
  value,
  options,
  writable,
  onChange,
  controlRef,
}: {
  controlRef: (element: HTMLSelectElement | null) => void;
  labelledBy: string;
  value: string;
  options: Option[];
  writable: FreshdeskWritable;
  onChange: (value: string) => void;
}) {
  return (
    <span className="relative inline-flex max-w-full">
      <select
        ref={controlRef}
        aria-labelledby={labelledBy}
        value={value}
        {...writable.controlProps}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-full appearance-none truncate rounded-md border border-border-primary bg-transparent py-0.5 pl-1.5 pr-6 text-row text-text-primary hover:border-border-secondary hover:bg-bg-hover disabled:opacity-60 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={12} aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
    </span>
  );
}

/** Agents by name; a name shared by two agents also shows the email, so "me" is never a guess */
function agentLabels(agents: HelpdeskAgent[]): Option[] {
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  return agents.map((a) => ({
    value: a.agentId,
    label: (counts.get(a.name) ?? 0) > 1 && a.email ? `${a.name} (${a.email})` : a.name,
  }));
}

type Editor = ReturnType<typeof useTicketEditor>;
type FieldName = "Status" | "Priority" | "Assignee";

/** A labelled state pill that opens an anchored menu. The accessible name is the field, not the value. */
export function PropertyPill({
  label,
  appearance,
  options,
  writable,
  open,
  onOpen,
  onClose,
  onSelect,
}: {
  label: string;
  appearance: BadgeAppearance;
  options: Option[];
  writable: FreshdeskWritable;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (value: string) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const Icon: LucideIcon = appearance.icon;
  const enabled = options.filter((option) => !option.disabled && option.value !== "");
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={writable.controlProps.title ?? appearance.title}
        disabled={writable.controlProps.disabled}
        aria-describedby={writable.controlProps["aria-describedby"]}
        onClick={() => (open ? onClose() : onOpen())}
        className={`inline-flex items-center gap-1.5 min-w-0 max-w-full rounded-full border pl-2 pr-1.5 py-0.5 text-preview font-medium transition-[filter] hover:brightness-110 disabled:opacity-70 disabled:hover:brightness-100 ${TONES[appearance.tone]}`}
      >
        <Icon size={12} aria-hidden className="shrink-0" />
        <span className="truncate">{appearance.label}</span>
        {!writable.controlProps.disabled && <ChevronDown size={12} aria-hidden className="shrink-0 opacity-70" />}
      </button>
      <Menu
        open={open && !writable.controlProps.disabled}
        onClose={onClose}
        label={label}
        anchorRef={anchorRef}
        items={enabled.map((option) => ({
          id: option.value,
          label: option.label,
          onSelect: () => onSelect(option.value),
        }))}
      />
    </>
  );
}

/**
 * Status, priority and assignee of the open ticket as controls. A change goes to
 * Freshdesk at once (never queued) and is rolled back if Freshdesk refuses it.
 * Offline, or while the helpdesk is unreachable, the controls are disabled with a
 * reason (see useFreshdeskWritable); `writable` lets the host show that reason.
 */
export function useTicketEditControls(ticket: TicketListItem | null, editor: Editor) {
  const controls = useRef<Partial<Record<FieldName, HTMLSelectElement | null>>>({});
  const options = useEditOptions();
  const writable = useFreshdeskWritable({ isSample: ticket?.isSample });
  const [openField, setOpenField] = useState<FieldName | null>(null);

  const render = (field: FieldName, labelledBy: string) => {
    if (!ticket) return null;
    if (field === "Status") {
      const opts: Option[] = options.statuses.map((s) => ({ value: s.id, label: s.label }));
      if (!opts.some((o) => o.value === ticket.status.id)) {
        opts.unshift({ value: ticket.status.id, label: ticket.status.label ?? `Unknown status (ID ${ticket.status.id})`, disabled: true });
      }
      const from = ticket.status.label ?? `Unknown status (ID ${ticket.status.id})`;
      return (
        <PropertyPill
          label="Status"
          appearance={statusAppearance(ticket.status)}
          options={opts}
          writable={writable}
          open={openField === "Status"}
          onOpen={() => setOpenField("Status")}
          onClose={() => setOpenField(null)}
          onSelect={(statusId) => {
            const target = options.statuses.find((s) => s.id === statusId);
            if (!target) return;
            void editor.run({
              ticket,
              changes: { statusId },
              shown: {
                status: { id: target.id, label: target.label, known: true, statusClass: target.statusClass },
                outstanding: target.statusClass !== "done",
              },
              action: `Change status to ${target.label}`,
              failure: `Status stays ${from}`,
            });
          }}
        />
      );
    }
    if (field === "Priority") {
      const opts: Option[] = options.priorities.map((p) => ({ value: p.choiceId, label: p.label }));
      const current = ticket.priority;
      if (!current) opts.unshift({ value: "", label: "None", disabled: true });
      else if (!opts.some((o) => o.value === current.id)) opts.unshift({ value: current.id, label: current.label, disabled: true });
      const appearance: BadgeAppearance = current
        ? priorityAppearance(current)
        : { tone: "neutral", icon: ChevronDown, label: "No priority", title: "Priority: None" };
      return (
        <PropertyPill
          label="Priority"
          appearance={appearance}
          options={opts}
          writable={writable}
          open={openField === "Priority"}
          onOpen={() => setOpenField("Priority")}
          onClose={() => setOpenField(null)}
          onSelect={(priorityId) => {
            const target = options.priorities.find((p) => p.choiceId === priorityId);
            if (!target) return;
            void editor.run({
              ticket,
              changes: { priorityId },
              shown: { priority: { id: target.choiceId, label: target.label } },
              action: `Change priority to ${target.label}`,
              failure: `Priority stays ${current?.label ?? "None"}`,
            });
          }}
        />
      );
    }
    const opts: Option[] = [{ value: "", label: "Unassigned" }, ...agentLabels(options.agents)];
    if (ticket.assigneeId && !opts.some((o) => o.value === ticket.assigneeId)) {
      opts.push({ value: ticket.assigneeId, label: ticket.assignee ?? `Agent ${ticket.assigneeId}`, disabled: true });
    }
    return (
      <EditSelect
        labelledBy={labelledBy}
        controlRef={(element) => { controls.current[field] = element; }}
        value={ticket.assigneeId ?? ""}
        options={opts}
        writable={writable}
        onChange={(value) => {
          const agent = options.agents.find((a) => a.agentId === value);
          void editor.run({
            ticket,
            changes: { assigneeId: value === "" ? null : value },
            shown: { assigneeId: value === "" ? null : value, assignee: agent?.name ?? null },
            action: agent ? `Assign to ${agent.name}` : "Unassign",
            failure: `Assignee stays ${ticket.assignee ?? "unassigned"}`,
          });
        }}
      />
    );
  };

  const focus = (field: FieldName) => {
    if (field === "Assignee") {
      controls.current.Assignee?.focus();
      return;
    }
    if (writable.writable) setOpenField(field);
  };
  return { render, focus, writable, blocked: writable.reason };
}
