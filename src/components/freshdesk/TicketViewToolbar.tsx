import { useEffect, useRef, useState } from "react";
import { Columns3, ListFilter, Pencil, Trash2 } from "lucide-react";
import {
  SORT_LABELS,
  availableOptionalColumns,
  type OptionalTicketColumn,
  type TicketSortKey,
} from "@/services/freshdesk/ticketViews";
import type { TicketListData } from "@/services/freshdesk/ticketSync";
import type { EmailDensity } from "@/stores/uiStore";
import { selectCurrentView, useTicketStore } from "@/stores/ticketStore";

export const COLUMN_LABELS: Record<OptionalTicketColumn, string> = {
  company_group: "Company / group",
  sla_due: "SLA due",
};

const DENSITY_LABELS: Record<EmailDensity, string> = { compact: "Compact", default: "Default", spacious: "Spacious" };

const control = "rounded-md border bg-bg-primary px-1.5 py-0.5 text-meta hover:bg-bg-hover";
const idle = "border-border-primary text-text-secondary";

/** Sort, filters, optional columns, density, and rename/delete for the operator's own views. */
export function TicketViewToolbar({
  data,
  filtersOpen,
  onToggleFilters,
}: {
  data: TicketListData | null;
  filtersOpen: boolean;
  onToggleFilters: () => void;
}) {
  const view = useTicketStore(selectCurrentView);
  const draft = useTicketStore((s) => s.draftFilter);
  const updateView = useTicketStore((s) => s.updateView);
  const deleteView = useTicketStore((s) => s.deleteView);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLSpanElement>(null);
  const columnsButtonRef = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const available = availableOptionalColumns(data);

  // A click outside the menu closes it; Escape (below) and this both hand focus back to the button
  useEffect(() => {
    if (!columnsOpen) return;
    const closeOnOutside = (e: MouseEvent) => {
      if (columnsRef.current?.contains(e.target as Node)) return;
      setColumnsOpen(false);
      columnsButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [columnsOpen]);

  const toggleColumn = (column: OptionalTicketColumn) =>
    void updateView(view.id, {
      columns: view.columns.includes(column) ? view.columns.filter((c) => c !== column) : [...view.columns, column],
    });

  const commitRename = () => {
    if (renaming?.trim()) void updateView(view.id, { name: renaming });
    setRenaming(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1.5">
      <select aria-label="Sort" value={view.sort} onChange={(e) => void updateView(view.id, { sort: e.target.value as TicketSortKey })} className={`${control} ${idle}`}>
        {(Object.keys(SORT_LABELS) as TicketSortKey[]).map((key) => (
          <option key={key} value={key}>
            {SORT_LABELS[key]}
          </option>
        ))}
      </select>
      <button type="button" aria-expanded={filtersOpen} onClick={onToggleFilters} className={`${control} inline-flex items-center gap-1 ${draft ? "border-accent/50 text-accent" : idle}`}>
        <ListFilter size={12} aria-hidden />
        Filters
        {draft && <span className="sr-only"> (edited)</span>}
      </button>
      <span
        ref={columnsRef}
        className="relative"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !columnsOpen) return;
          // Only the menu closes: the Escape must not also reach the list's own shortcuts
          e.stopPropagation();
          setColumnsOpen(false);
          columnsButtonRef.current?.focus();
        }}
      >
        <button ref={columnsButtonRef} type="button" aria-expanded={columnsOpen} onClick={() => setColumnsOpen((o) => !o)} className={`${control} ${idle} inline-flex items-center gap-1`}>
          <Columns3 size={12} aria-hidden />
          Columns
        </button>
        {columnsOpen && (
          <div role="group" aria-label="Optional columns" className="absolute left-0 top-full z-20 mt-1 min-w-48 rounded-lg border border-border-primary bg-bg-primary p-2 text-meta shadow-lg">
            {available.length === 0 ? (
              <p className="text-text-tertiary">No optional columns: Freshdesk has not provided company, group or SLA data.</p>
            ) : (
              available.map((column) => (
                <label key={column} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-text-primary hover:bg-bg-hover">
                  <input type="checkbox" checked={view.columns.includes(column)} onChange={() => toggleColumn(column)} />
                  {COLUMN_LABELS[column]}
                </label>
              ))
            )}
          </div>
        )}
      </span>
      <select aria-label="Density" value={view.density} onChange={(e) => void updateView(view.id, { density: e.target.value as EmailDensity })} className={`${control} ${idle}`}>
        {(Object.keys(DENSITY_LABELS) as EmailDensity[]).map((d) => (
          <option key={d} value={d}>
            {DENSITY_LABELS[d]}
          </option>
        ))}
      </select>
      {view.kind === "custom" &&
        (renaming !== null ? (
          <input
            type="text"
            aria-label="View name"
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={commitRename}
            className="min-w-0 w-36 rounded-md border border-accent/50 bg-bg-primary px-1.5 py-0.5 text-meta"
          />
        ) : (
          <span className="ml-auto inline-flex items-center gap-0.5">
            <button type="button" aria-label="Rename view" title="Rename view" onClick={() => setRenaming(view.name)} className="rounded-md p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-primary">
              <Pencil size={12} />
            </button>
            <button type="button" aria-label="Delete view" title="Delete view" onClick={() => void deleteView(view.id)} className="rounded-md p-1 text-text-tertiary hover:bg-bg-hover hover:text-danger">
              <Trash2 size={12} />
            </button>
          </span>
        ))}
    </div>
  );
}
