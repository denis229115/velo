import { useCallback, useState, type FormEvent } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { navigateToTicket } from "@/router/navigate";
import { selectCurrentView, selectVisibleTickets, useTicketStore } from "@/stores/ticketStore";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { RequiredField, TicketChanges, TicketEditResult } from "@/services/freshdesk/ticketEdits";

export interface TicketEditRequest {
  ticket: TicketListItem;
  changes: TicketChanges;
  /** What the operator sees at once; rolled back unless Freshdesk confirms */
  shown: Partial<TicketListItem>;
  /** The action in the operator's words, e.g. "Move to Resolved" */
  action: string;
  /** What stays true when the change fails, e.g. "Ticket #1001 stays in Open" */
  failure: string;
  /** Board moves: say so when the ticket no longer matches the view */
  checkView?: boolean;
}

interface LeftView {
  ticketId: string;
  now: string;
  viewName: string;
}

/**
 * Runs status, priority and assignee changes against Freshdesk and renders what
 * they may need: the required-field prompt, the left-the-view confirmation and
 * the error of a rejected change (which is already rolled back).
 */
export function useTicketEditor() {
  const editTicket = useTicketStore((s) => s.editTicket);
  const [error, setError] = useState<{ ticketId: string; text: string } | null>(null);
  const [asking, setAsking] = useState<{ request: TicketEditRequest; fields: RequiredField[] } | null>(null);
  const [leftView, setLeftView] = useState<LeftView | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (request: TicketEditRequest, requiredFields?: Record<string, string>): Promise<TicketEditResult> => {
      setError(null);
      setBusy(true);
      const result = await editTicket(request.ticket.id, request.changes, request.shown, requiredFields).finally(() =>
        setBusy(false),
      );
      if (result.outcome === "confirmed") {
        setAsking(null);
        const state = useTicketStore.getState();
        if (request.checkView && !selectVisibleTickets(state).some((t) => t.id === request.ticket.id)) {
          const now = state.data?.tickets.find((t) => t.id === request.ticket.id)?.status.label ?? "changed";
          setLeftView({ ticketId: request.ticket.id, now, viewName: selectCurrentView(state).name });
        }
      } else if (result.outcome === "needs_fields") {
        setAsking({ request, fields: result.fields });
      } else {
        setAsking(null);
        setError({ ticketId: request.ticket.id, text: `${request.failure}. ${result.message}` });
      }
      return result;
    },
    [editTicket],
  );

  const element = (
    <>
      {asking && (
        <RequiredFieldsDialog
          request={asking.request}
          fields={asking.fields}
          busy={busy}
          onSubmit={(values) => void run(asking.request, values)}
          onCancel={() => setAsking(null)}
        />
      )}
      {leftView && <LeftViewDialog leftView={leftView} onClose={() => setLeftView(null)} />}
    </>
  );

  return { run, busy, error, clearError: () => setError(null), element };
}

/** A rejected change, already rolled back, in Freshdesk's own words */
export function TicketEditError({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-meta text-status-error"
    >
      <AlertTriangle size={14} aria-hidden className="mt-px shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-status-error/15">
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}

function RequiredFieldsDialog({
  request,
  fields,
  busy,
  onSubmit,
  onCancel,
}: {
  request: TicketEditRequest;
  fields: RequiredField[];
  busy: boolean;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = fields.every((f) => (values[f.name] ?? "").trim() !== "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete) onSubmit(values);
  };
  return (
    <Modal isOpen onClose={onCancel} title="Freshdesk needs more information" width="w-96">
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <p className="text-meta text-text-secondary">
          {request.action} for ticket #{request.ticket.id}: Freshdesk requires {fields.length === 1 ? "this field" : "these fields"}.
        </p>
        {fields.map((field, i) => {
          const id = `required-field-${field.name}`;
          const control =
            "w-full rounded-md border border-border-primary bg-bg-primary px-2 py-1.5 text-row text-text-primary focus-visible:outline-2 focus-visible:outline-accent";
          return (
            <div key={field.name} className="space-y-1">
              <label htmlFor={id} className="block text-meta font-medium text-text-primary">
                {field.label}
              </label>
              {field.choices ? (
                <select
                  id={id}
                  autoFocus={i === 0}
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                  className={control}
                >
                  <option value="">Choose…</option>
                  {field.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  autoFocus={i === 0}
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                  className={control}
                />
              )}
              <p className="text-micro text-text-tertiary">Freshdesk: {field.message}</p>
            </div>
          );
        })}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!complete || busy}>
            {request.action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LeftViewDialog({ leftView, onClose }: { leftView: LeftView; onClose: () => void }) {
  return (
    <Modal isOpen onClose={onClose} title="Ticket moved" width="w-96">
      <div className="space-y-3 px-4 py-3">
        <p className="text-row text-text-primary">
          Ticket #{leftView.ticketId} is now {leftView.now} and no longer matches “{leftView.viewName}”.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              onClose();
              navigateToTicket(leftView.ticketId);
            }}
          >
            Open ticket
          </Button>
          <Button type="button" variant="primary" size="sm" autoFocus onClick={onClose}>
            OK
          </Button>
        </div>
      </div>
    </Modal>
  );
}
