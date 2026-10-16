import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { TaskDrawer } from "./TaskDrawer";
import { AssigneePicker, ListPicker } from "./TaskChoicePickers";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { FreshdeskWriteReason } from "@/components/freshdesk/useFreshdeskWritable";
import { BACKLINK_LABELS } from "@/services/clickup/backlinks";
import { BACKLINK_STEPS } from "@/services/db/taskLinks";
import type { LinkedItem } from "@/services/clickup/links";
import {
  createTaskFromItem,
  getCreateTaskOptions,
  getTaskListDetails,
  type TaskListDetails,
  reconcileTaskCreation,
  type CreateTaskOptions,
  type CreateTaskResult,
  type TaskPriority,
} from "@/services/clickup/taskCreate";
import { TaskProposalPanel, type TaskProposalControls } from "./TaskProposalPanel";
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
  proposalSlot?: ReactNode | ((controls: TaskProposalControls) => ReactNode);
}) {
  const writable = useClickUpWritable(item);
  const [options, setOptions] = useState<CreateTaskOptions | null>(null);
  const [listId, setListId] = useState("");
  const [name, setName] = useState("");
  const titleEdited = useRef(false);
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
  const [loadingLists, setLoadingLists] = useState(true);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [missingDestination, setMissingDestination] = useState<string | null>(null);
  const [details, setDetails] = useState<(TaskListDetails & { tenantId: string; stamp: number | null }) | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const refreshGeneration = useRef(0);
  const selectedList = useRef(listId);
  selectedList.current = listId;
  const selectedLabel = useRef("");
  const selected = options?.lists.find((l) => l.listId === listId);
  if (selected) selectedLabel.current = `${selected.name} (${selected.location})`;

  const refreshLists = async (initial = false) => {
    const generation = ++refreshGeneration.current;
    setLoadingLists(true);
    setDiscoveryError(null);
    setDetails(null);
    try {
      const o = await getCreateTaskOptions(item, { refresh: true });
      if (generation !== refreshGeneration.current) return;
      setOptions(o);
      const current = selectedList.current;
      // An explicit choice survives refresh; a removed list stays unselected until reviewed.
      const found = o.lists.some((l) => l.listId === current);
      setListId(current ? found ? current : "" : initial ? o.initialListId ?? "" : "");
      setMissingDestination(current && !found ? selectedLabel.current : null);
      if (initial && !titleEdited.current) setName(o.suggestedName);
    } catch (err) {
      if (generation === refreshGeneration.current) setDiscoveryError(errorMessage(err));
    } finally {
      if (generation === refreshGeneration.current) setLoadingLists(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const generation = refreshGeneration.current;
    getCreateTaskOptions(item)
      .then((o) => {
        if (cancelled || generation !== refreshGeneration.current) return;
        setOptions(o);
        setListId(o.initialListId ?? "");
        if (!titleEdited.current) setName(o.suggestedName);
        void refreshLists(true);
      })
      .catch((err) => { if (!cancelled) { setDiscoveryError(errorMessage(err)); setLoadingLists(false); } });
    return () => { cancelled = true; refreshGeneration.current++; };
    // One item per drawer; refresh never overwrites edited text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const changed = () => {
      refreshGeneration.current++;
      setOptions(null);
      setMissingDestination(null);
      setListId("");
      setDetails(null);
      setAssigneeIds([]);
      setStatus("");
      setLoadingLists(false);
      setDiscoveryError("The ClickUp connection changed. Close and reopen the drawer; your text stays here until you close it.");
    };
    window.addEventListener("velo-clickup-connection-changed", changed);
    return () => window.removeEventListener("velo-clickup-connection-changed", changed);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setMembersError(null);
    if (!listId || !options?.tenantId || loadingLists || discoveryError) return;
    const tenantId = options.tenantId;
    getTaskListDetails(listId, tenantId).then((d) => {
      if (cancelled) return;
      setDetails({ ...d, tenantId, stamp: options.discoveryRefreshedAt });
      setAssigneeIds((ids) => ids.filter((id) => d.members.some((m) => m.userId === id)));
      setStatus((current) => d.statuses.includes(current) ? current : "");
    }).catch((err) => !cancelled && setMembersError(errorMessage(err)));
    return () => { cancelled = true; };
  }, [listId, options?.tenantId, options?.discoveryRefreshedAt, loadingLists, discoveryError, detailRetry]);

  const list = options?.lists.find((l) => l.listId === listId) ?? null;
  const listReady = !loadingLists && !discoveryError && details?.listId === listId && details?.tenantId === options?.tenantId && details?.stamp === options?.discoveryRefreshedAt;
  const members = listReady ? details!.members : null;
  const fieldGap = item.kind === "ticket" && listReady ? details!.fieldGap : null;

  const chooseList = (id: string) => {
    if (id === listId) return;
    setListId(id);
    setMissingDestination(null);
    // Statuses and members belong to one list
    setStatus("");
    setDetails(null);
    setMembersError(null);
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
    if (busy || unconfirmed || !list || !listReady || !name.trim() || writable.controlProps.disabled) return;
    void run(() =>
      createTaskFromItem(item, {
        expectedTenantId: options?.tenantId ?? undefined,
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
  const proposalControls: TaskProposalControls = {
    locked,
    onApply: (text, how) => {
      if (locked) return;
      titleEdited.current = true;
      setName((current) => how === "replace" ? text.title : [current, text.title].filter(Boolean).join(" — "));
      setDescription((current) => how === "replace" ? text.description : [current, text.description].filter(Boolean).join("\n\n"));
    },
  };

  return (
    <TaskDrawer onClose={onClose} title="Create a ClickUp task">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col flex-1 min-h-0"
      >
        {/* The fields scroll; the actions below them stay in view */}
        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {item.kind === "ticket" ? (
            <p className="text-meta text-text-secondary">From ticket #{item.ticketId}</p>
          ) : (
            <p className="text-meta text-text-secondary">
              Nothing from this email is sent to ClickUp automatically. Only the title and description you choose are sent; the link is kept only in Velo.
            </p>
          )}
          {options && options.lists.length === 0 && (
            <p role="alert" className="text-meta text-danger">
              {options.tenantId ? "ClickUp returned no accessible lists. Refresh lists or check your access in ClickUp." : "Connect a ClickUp workspace in Settings → ClickUp to create tasks."}
            </p>
          )}
          <div>
            <ListPicker lists={options?.lists ?? []} value={listId} disabled={locked || loadingLists || !options} onChange={chooseList} />
            <div className="flex items-center justify-between gap-2 mt-1.5 text-micro text-text-tertiary">
              <span>{options?.discoveryRefreshedAt ? <>Last refreshed <time dateTime={new Date(options.discoveryRefreshedAt).toISOString()}>{new Date(options.discoveryRefreshedAt).toLocaleString()}</time></> : "Lists have not been refreshed."}{loadingLists && <span role="status" className="block">Refreshing lists from ClickUp…</span>}</span>
              <button type="button" disabled={locked || loadingLists} onClick={() => void refreshLists()} className="shrink-0 text-link disabled:opacity-50">Refresh lists</button>
            </div>
            {options && !options.discoveryComplete && <p role="status" className="mt-1 text-micro text-status-warning">Partial coverage: searching only the discovered lists (up to 1,000 lists and 200 hierarchy requests). Other lists may be missing.</p>}
            {discoveryError && <div role="alert" className="mt-1 text-meta text-danger"><p>{discoveryError} {options?.lists.length ? "Cached destinations are shown; creation is disabled until refresh succeeds." : "Creation is disabled until the destination is refreshed."}</p><button type="button" disabled={locked || loadingLists} onClick={() => void refreshLists()}>Retry lists</button></div>}
            {missingDestination && <p role="status" className="mt-1 text-meta text-status-warning">The previous destination “{missingDestination}” was not returned by ClickUp. Choose a destination; your other fields are kept.</p>}
            {fieldGap && (
              <p role="status" className="mt-1.5 flex items-start gap-1.5 text-meta text-status-warning">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
                <span>{fieldGap} The ticket link and the internal note are still written.</span>
              </p>
            )}
          </div>
          {typeof proposalSlot === "function" ? proposalSlot(proposalControls) : proposalSlot === undefined ? <TaskProposalPanel item={item} {...proposalControls} /> : proposalSlot}
          <TextField
            id="create-task-title"
            label="Title"
            size="md"
            value={name}
            disabled={locked}
            onChange={(e) => { titleEdited.current = true; setName(e.target.value); }}
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="create-task-status" className={LABEL_CLASS}>
                Status
              </label>
              <select
                id="create-task-status"
                value={status}
                disabled={locked || !listReady}
                onChange={(e) => setStatus(e.target.value)}
                className={FIELD_CLASS}
              >
                {details && listReady && details.statuses.map((s, i) => (
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
              <div role="alert" className="text-meta text-danger"><p>{membersError}</p><button type="button" disabled={locked} onClick={() => setDetailRetry((n) => n + 1)}>Retry list details</button></div>
            ) : members === null ? (
              <p role="status" className="text-meta text-text-tertiary">{listId ? "Reading the list's members and statuses…" : "Choose a list first."}</p>
            ) : <AssigneePicker key={listId} members={members} selected={assigneeIds} meUserId={options?.meUserId ?? null} disabled={locked} onToggle={toggleAssignee} />}

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
            disabled={locked || !list || !listReady || !name.trim() || writable.controlProps.disabled}
          >
            <Plus size={14} aria-hidden />
            {busy ? "Creating…" : "Create task"}
          </Button>
        </div>
      </form>
    </TaskDrawer>
  );
}
