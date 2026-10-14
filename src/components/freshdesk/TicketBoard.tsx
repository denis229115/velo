import { useEffect, useMemo, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { ChevronsLeft, ChevronsRight, CircleHelp } from "lucide-react";
import { useTicketStore } from "@/stores/ticketStore";
import { getStatusClassification, type ClassifiableStatus } from "@/services/freshdesk/connection";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { TicketView } from "@/services/freshdesk/ticketViews";
import { TicketCard } from "./TicketCard";
import { TicketEditError, useTicketEditor } from "./useTicketEditor";
import { FreshdeskWriteReason, useFreshdeskWritable } from "./useFreshdeskWritable";

interface BoardColumn {
  statusId: string;
  label: string;
  /** False for a status ID the helpdesk's metadata doesn't have: shown, never a drop target */
  known: boolean;
  tickets: TicketListItem[];
}

/** One column per Freshdesk status, by ID and in Freshdesk's order, then any unknown status IDs. */
function boardColumns(statuses: ClassifiableStatus[], tickets: TicketListItem[]): BoardColumn[] {
  const columns: BoardColumn[] = statuses.map((s) => ({ statusId: s.id, label: s.label, known: true, tickets: [] }));
  const byId = new Map(columns.map((c) => [c.statusId, c]));
  for (const t of tickets) {
    let column = byId.get(t.status.id);
    if (!column) {
      column = { statusId: t.status.id, label: `Unknown status (ID ${t.status.id})`, known: false, tickets: [] };
      byId.set(t.status.id, column);
      columns.push(column);
    }
    column.tickets.push(t);
  }
  return columns;
}

/** The board presentation of a ticket view: the same filtered, sorted tickets as the list. */
export function TicketBoard({
  tickets,
  view,
  selectedTicketId,
}: {
  tickets: TicketListItem[];
  view: TicketView;
  selectedTicketId: string | null;
}) {
  const version = useTicketStore((s) => s.version);
  const linkedWork = useTicketStore((s) => s.linkedWork);
  const updateView = useTicketStore((s) => s.updateView);
  const writable = useFreshdeskWritable();
  const editor = useTicketEditor();
  const [statuses, setStatuses] = useState<ClassifiableStatus[]>([]);
  const [dragging, setDragging] = useState<TicketListItem | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    let cancelled = false;
    void getStatusClassification().then((c) => {
      if (!cancelled) setStatuses(c.statuses);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const columns = useMemo(() => boardColumns(statuses, tickets), [statuses, tickets]);
  // Done columns start collapsed until the operator changes it; the choice is kept per view
  const collapsed = useMemo(
    () => new Set(view.board.collapsedStatusIds ?? statuses.filter((s) => s.statusClass === "done").map((s) => s.id)),
    [view.board.collapsedStatusIds, statuses],
  );
  const toggle = (statusId: string) => {
    const next = new Set(collapsed);
    if (next.has(statusId)) next.delete(statusId);
    else next.add(statusId);
    void updateView(view.id, { board: { ...view.board, collapsedStatusIds: [...next] } });
  };

  const move = (ticket: TicketListItem, statusId: string) => {
    const target = statuses.find((s) => s.id === statusId);
    if (!target || statusId === ticket.status.id || !writable.writable) return;
    const from = ticket.status.label ?? `status ID ${ticket.status.id}`;
    void editor.run({
      ticket,
      changes: { statusId },
      shown: {
        status: { id: target.id, label: target.label, known: true, statusClass: target.statusClass },
        outstanding: target.statusClass !== "done",
      },
      action: `Move to ${target.label}`,
      failure: `Ticket #${ticket.id} stays in ${ticket.status.known ? from : `Unknown status (ID ${ticket.status.id})`}`,
      checkView: true,
    });
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = (e.active.data.current as { ticketId?: string } | undefined)?.ticketId;
    setDragging(tickets.find((t) => t.id === id) ?? null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const id = (e.active.data.current as { ticketId?: string } | undefined)?.ticketId;
    const ticket = tickets.find((t) => t.id === id);
    const overId = e.over ? String(e.over.id) : "";
    if (ticket && overId.startsWith("status:")) move(ticket, overId.slice("status:".length));
  };

  return (
    <section aria-label="Ticket board" className="flex min-h-0 flex-1 flex-col">
      {(!writable.writable || editor.error) && (
        <div className="space-y-1.5 px-3 pt-2">
          <FreshdeskWriteReason writable={writable} />
          {editor.error && <TicketEditError text={editor.error.text} onDismiss={editor.clearError} />}
        </div>
      )}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
          {columns.map((column) =>
            collapsed.has(column.statusId) ? (
              <CollapsedColumn key={column.statusId} column={column} onExpand={() => toggle(column.statusId)} />
            ) : (
              <ExpandedColumn key={column.statusId} column={column} onCollapse={() => toggle(column.statusId)}>
                {column.tickets.map((t) => (
                  <TicketCard
                    key={t.id}
                    ticket={t}
                    linkedWork={linkedWork.get(t.id)}
                    selected={t.id === selectedTicketId}
                    statuses={statuses}
                    writable={writable}
                    onMove={move}
                  />
                ))}
              </ExpandedColumn>
            ),
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div className="w-64 rounded-md border border-accent bg-surface-base px-2.5 py-2 text-row font-medium text-text-primary overlay-shadow">
              #{dragging.id} {dragging.subject}
            </div>
          )}
        </DragOverlay>
      </DndContext>
      {editor.element}
    </section>
  );
}

function useColumnDrop(column: BoardColumn) {
  return useDroppable({ id: `status:${column.statusId}`, disabled: !column.known });
}

function ColumnTitle({ column }: { column: BoardColumn }) {
  return (
    <>
      {!column.known && <CircleHelp size={12} aria-hidden className="shrink-0 text-status-error" />}
      <span className={`truncate font-medium ${column.known ? "text-text-primary" : "text-status-error"}`}>{column.label}</span>
      <span className="shrink-0 tabular-nums text-text-tertiary">{column.tickets.length}</span>
    </>
  );
}

function ExpandedColumn({ column, onCollapse, children }: { column: BoardColumn; onCollapse: () => void; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useColumnDrop(column);
  return (
    <section
      ref={setNodeRef}
      aria-label={`${column.label} column`}
      className={`flex w-64 shrink-0 flex-col rounded-lg border bg-surface-subtle ${
        isOver ? "border-accent ring-1 ring-accent/40" : "border-border-primary"
      }`}
    >
      <header className="flex items-center gap-1.5 px-2.5 py-2 text-meta">
        <ColumnTitle column={column} />
        <button
          type="button"
          onClick={onCollapse}
          aria-expanded
          aria-label={`Collapse ${column.label} column`}
          title="Collapse column"
          className="ml-auto shrink-0 rounded p-0.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
        >
          <ChevronsLeft size={13} aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
        {column.tickets.length === 0 ? (
          <p className="px-1 py-4 text-center text-meta text-text-tertiary">No tickets in this view</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/** A collapsed column stays visible as a strip with its name and count; it still takes drops. */
function CollapsedColumn({ column, onExpand }: { column: BoardColumn; onExpand: () => void }) {
  const { setNodeRef, isOver } = useColumnDrop(column);
  const count = column.tickets.length;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${column.label} column`}
      className={`flex w-10 shrink-0 flex-col rounded-lg border bg-surface-subtle ${
        isOver ? "border-accent ring-1 ring-accent/40" : "border-dashed border-border-primary"
      }`}
    >
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={false}
        aria-label={`${column.label}, ${count} ticket${count === 1 ? "" : "s"}, collapsed. Expand column`}
        title="Expand column"
        className="flex flex-1 flex-col items-center gap-2 rounded-lg py-2 text-meta hover:bg-bg-hover"
      >
        <ChevronsRight size={13} aria-hidden className="shrink-0 text-text-tertiary" />
        <span className="flex items-center gap-1.5 [writing-mode:vertical-rl]">
          <ColumnTitle column={column} />
        </span>
      </button>
    </section>
  );
}
