import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { FreshdeskWriteReason } from "@/components/freshdesk/useFreshdeskWritable";
import { BACKLINK_LABELS } from "@/services/clickup/backlinks";
import { BACKLINK_STEPS } from "@/services/db/taskLinks";
import type { LinkedItem } from "@/services/clickup/links";
import type { ClickUpMember } from "@/services/clickup/metadata";
import {
  createTaskFromItem,
  getCreateTaskOptions,
  getListMembers,
  reconcileTaskCreation,
  type CreateTaskOptions,
  type CreateTaskResult,
  type TaskPriority,
} from "@/services/clickup/taskCreate";
import { useClickUpWritable } from "./useClickUpWritable";

const FIELD_CLASS =
  "block w-full bg-bg-tertiary text-text-primary text-sm px-2 py-1.5 rounded border border-border-primary focus:border-accent outline-none disabled:opacity-60";
const LABEL_CLASS = "text-sm text-text-secondary block mb-1.5";

const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Normal" },
  { value: 4, label: "Low" },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

/** The list's members, read from ClickUp whenever the destination changes */
function useListMembers(listId: string) {
  const [members, setMembers] = useState<ClickUpMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setError(null);
    if (!listId) return;
    getListMembers(listId)
      .then((m) => !cancelled && setMembers(m))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [listId]);
  return { members, error };
}

/**
 * Creates a ClickUp task from a ticket or an email thread. The destination
 * list is always shown. A ticket's task gets its three backlinks; a task from
 * an email carries only what the operator types here.
 */
export function CreateTaskDialog({
  item,
  onClose,
  onCreated,
  proposalSlot,
}: {
  item: LinkedItem;
  onClose: () => void;
  onCreated: () => void;
  /** Where AI-proposed task text is offered (#16); the dialog works without it */
  proposalSlot?: ReactNode;
}) {
  const writable = useClickUpWritable(item);
  const [options, setOptions] = useState<CreateTaskOptions | null>(null);
  const [listId, setListId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [status, setStatus] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A creation ClickUp never answered: only Check ClickUp may settle it */
  const [unconfirmed, setUnconfirmed] = useState<{
    operationId: string;
    message: string;
  } | null>(null);
  const { members, error: membersError } = useListMembers(listId);

  useEffect(() => {
    let cancelled = false;
    getCreateTaskOptions(item)
      .then((o) => {
        if (cancelled) return;
        setOptions(o);
        setListId(o.initialListId ?? "");
        setName(o.suggestedName);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
    // The dialog is opened for one item and closed before another
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = options?.lists.find((l) => l.listId === listId) ?? null;
  const fieldGap = item.kind === "ticket" ? (options?.fieldGaps[listId] ?? null) : null;

  const chooseList = (id: string) => {
    setListId(id);
    // Statuses and members belong to one list
    setStatus("");
    setAssigneeIds([]);
  };

  const settle = (result: CreateTaskResult) => {
    if (result.outcome === "created") {
      onCreated();
      return;
    }
    if (result.outcome === "unconfirmed") {
      setUnconfirmed({
        operationId: result.operationId,
        message: result.message,
      });
      return;
    }
    setUnconfirmed(null);
    setError(result.message);
  };

  const run = async (action: () => Promise<CreateTaskResult>) => {
    setBusy(true);
    setError(null);
    try {
      settle(await action());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || unconfirmed || !list || !name.trim()) return;
    void run(() =>
      createTaskFromItem(item, {
        listId,
        name: name.trim(),
        description,
        assigneeIds,
        priority,
        status: status || null,
        dueDate: dueDate || null,
      }),
    );
  };

  const toggleAssignee = (userId: string) =>
    setAssigneeIds((ids) => (ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId]));

  const locked = busy || unconfirmed !== null;

  return (
    <Modal isOpen onClose={onClose} title="Create a ClickUp task" width="w-[36rem]">
      <form
        role="dialog"
        aria-label="Create a ClickUp task"
        onSubmit={handleSubmit}
        className="flex flex-col max-h-[75vh]"
      >
        {/* The fields scroll; the actions below them stay in view */}
        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {item.kind === "ticket" ? (
            <p className="text-meta text-text-secondary">From ticket #{item.ticketId}</p>
          ) : (
            <p className="text-meta text-text-secondary">
              Nothing from this email is sent to ClickUp; the link is kept only in Velo.
            </p>
          )}
          {options && options.lists.length === 0 && (
            <p role="alert" className="text-meta text-danger">
              Connect a ClickUp workspace in Settings → ClickUp to create tasks.
            </p>
          )}
          <div>
            <label htmlFor="create-task-list" className={LABEL_CLASS}>
              List
            </label>
            <select
              id="create-task-list"
              value={listId}
              disabled={locked || !options}
              onChange={(e) => chooseList(e.target.value)}
              className={FIELD_CLASS}
            >
              {options?.lists.map((l) => (
                <option key={l.listId} value={l.listId}>
                  {l.name} ({l.location})
                </option>
              ))}
            </select>
            {fieldGap && (
              <p role="status" className="mt-1.5 flex items-start gap-1.5 text-meta text-status-warning">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
                <span>{fieldGap} The ticket link and the internal note are still written.</span>
              </p>
            )}
          </div>
          {proposalSlot}
          <TextField
            id="create-task-title"
            label="Title"
            size="md"
            value={name}
            disabled={locked}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          <div>
            <label htmlFor="create-task-description" className={LABEL_CLASS}>
              Description
            </label>
            <textarea
              id="create-task-description"
              value={description}
              disabled={locked}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className={`${FIELD_CLASS} resize-y placeholder:text-text-tertiary`}
              placeholder={item.kind === "ticket" ? "Velo adds the ticket link below what you write." : undefined}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="create-task-status" className={LABEL_CLASS}>
                Status
              </label>
              <select
                id="create-task-status"
                value={status}
                disabled={locked || !list}
                onChange={(e) => setStatus(e.target.value)}
                className={FIELD_CLASS}
              >
                {list?.statuses.map((s, i) => (
                  <option key={s} value={i === 0 ? "" : s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="create-task-priority" className={LABEL_CLASS}>
                Priority
              </label>
              <select
                id="create-task-priority"
                value={priority ?? ""}
                disabled={locked}
                onChange={(e) => setPriority(e.target.value ? (Number(e.target.value) as TaskPriority) : null)}
                className={FIELD_CLASS}
              >
                <option value="">No priority</option>
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="create-task-due" className={LABEL_CLASS}>
                Due date
              </label>
              <input
                id="create-task-due"
                type="date"
                value={dueDate}
                disabled={locked}
                onChange={(e) => setDueDate(e.target.value)}
                className={`${FIELD_CLASS} dark:[color-scheme:dark]`}
              />
            </div>
          </div>
          <fieldset>
            <legend className={LABEL_CLASS}>Assignees</legend>
            {membersError ? (
              <p className="text-meta text-danger">{membersError}</p>
            ) : members === null ? (
              <p className="text-meta text-text-tertiary">
                {listId ? "Reading the list's members…" : "Choose a list first."}
              </p>
            ) : members.length === 0 ? (
              <p className="text-meta text-text-tertiary">Nobody can be assigned in this list.</p>
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {members.map((m) => (
                  <label key={m.userId} className="inline-flex items-center gap-1.5 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={assigneeIds.includes(m.userId)}
                      disabled={locked}
                      onChange={() => toggleAssignee(m.userId)}
                      className="accent-accent"
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {item.kind === "ticket" && (
            <div className="rounded-md border border-border-primary px-3 py-2">
              <p id="create-task-backlinks" className="text-meta text-text-secondary mb-1">
                Velo then writes these backlinks:
              </p>
              <ul aria-label="Backlinks Velo writes" className="list-disc pl-5 text-meta text-text-primary">
                {BACKLINK_STEPS.map((step) => (
                  <li key={step}>
                    {BACKLINK_LABELS[step]}
                    {step === "ticketIdField" && fieldGap && (
                      <span className="text-text-tertiary"> (skipped for this list)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unconfirmed && (
            <div
              role="alert"
              className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 space-y-2"
            >
              <p className="text-meta text-text-primary">{unconfirmed.message}</p>
              <Button
                size="sm"
                variant="secondary"
                {...writable.controlProps}
                disabled={busy || writable.controlProps.disabled}
                onClick={() => void run(() => reconcileTaskCreation(unconfirmed.operationId))}
              >
                <RefreshCw size={13} aria-hidden />
                Check ClickUp
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-meta text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-primary">
          <FreshdeskWriteReason writable={writable} className="text-meta text-text-tertiary mr-auto" />
          <Button type="button" variant="secondary" size="md" onClick={onClose}>
            {unconfirmed ? "Close" : "Cancel"}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            {...writable.controlProps}
            disabled={locked || !list || !name.trim() || writable.controlProps.disabled}
          >
            <Plus size={14} aria-hidden />
            {busy ? "Creating…" : "Create task"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
