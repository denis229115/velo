import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, ExternalLink, Link2, Plus, RefreshCw, Unlink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Timestamp, useDisplayTimeZone } from "@/components/ui/Timestamp";
import { FreshdeskWriteReason, type FreshdeskWritable } from "@/components/freshdesk/useFreshdeskWritable";
import {
  getRelatedTasks,
  refreshRelatedTasks,
  unlinkTask,
  type LinkedItem,
  type RelatedTask,
  type RelatedTasksView,
} from "@/services/clickup/links";
import {
  getPendingTaskCreations,
  reconcileTaskCreation,
  retryMissingBacklinks,
  type PendingTaskCreation,
} from "@/services/clickup/taskCreate";
import { TaskDrawer } from "./TaskDrawer";
import { CreateTaskDialog } from "./CreateTaskDialog";
import { LinkTaskDialog } from "./LinkTaskDialog";
import { useClickUpWritable } from "./useClickUpWritable";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function itemKey(item: LinkedItem): string {
  return item.kind === "ticket" ? `ticket:${item.ticketId}` : `email:${item.accountId}:${item.threadId}`;
}

/** ClickUp's own status name; a done task also carries a Done badge, so colour is never the only cue. */
function TaskStatus({ task }: { task: RelatedTask }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span
        aria-hidden
        className="w-2 h-2 rounded-full shrink-0 bg-text-tertiary"
        style={task.statusColor ? { backgroundColor: task.statusColor } : undefined}
      />
      <span className="truncate">{task.status}</span>
      {task.done && (
        <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-micro font-medium border-status-success/40 bg-status-success/10 text-status-success">
          <CircleCheck size={11} aria-hidden />
          Done
        </span>
      )}
    </span>
  );
}

function DueDate({ at }: { at: number }) {
  const timeZone = useDisplayTimeZone();
  const text = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone,
  }).format(at);
  return <span>Due {text}</span>;
}

const BACKLINK_STATE_TEXT: Record<RelatedTask["backlinks"][number]["state"], string> = {
  done: "Written",
  pending: "Not written yet",
  failed: "Failed",
  unconfirmed: "Not confirmed",
  skipped: "Skipped",
};

const BACKLINK_STATE_CLASS: Record<RelatedTask["backlinks"][number]["state"], string> = {
  done: "text-status-success",
  pending: "text-status-warning",
  failed: "text-danger",
  unconfirmed: "text-status-warning",
  skipped: "text-text-tertiary",
};

/** Whether a backlink still has to be written: a retry writes exactly these */
const isMissing = (state: RelatedTask["backlinks"][number]["state"]) => state !== "done" && state !== "skipped";

/** A ticket link's three backlinks; shown in full only while one is missing or was skipped */
function Backlinks({
  task,
  busy,
  writable,
  onRetry,
}: {
  task: RelatedTask;
  busy: boolean;
  writable: FreshdeskWritable;
  onRetry: () => void;
}) {
  if (task.backlinks.length === 0) return null;
  const missing = task.backlinks.some((b) => isMissing(b.state));
  const notable = missing || task.backlinks.some((b) => b.state === "skipped");
  if (!notable) return <p className="mt-1 text-micro text-text-tertiary">Backlinks written</p>;
  return (
    <div className="mt-2 rounded-md border border-border-primary px-2.5 py-2">
      <ul aria-label={`Backlinks of ${task.name}`} className="space-y-1">
        {task.backlinks.map((b) => (
          <li key={b.step} aria-label={b.label} className="text-meta">
            <span className="text-text-primary">{b.label}</span>
            {": "}
            <span className={`font-medium ${BACKLINK_STATE_CLASS[b.state]}`}>{BACKLINK_STATE_TEXT[b.state]}</span>
            {b.message && <span className="block text-micro text-text-secondary">{b.message}</span>}
          </li>
        ))}
      </ul>
      {missing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            {...writable.controlProps}
            disabled={busy || writable.controlProps.disabled}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border-primary text-meta text-text-primary hover:bg-bg-hover disabled:opacity-50"
          >
            <RefreshCw size={12} aria-hidden />
            Retry missing backlink
          </button>
          <span className="text-micro text-text-tertiary">Only what is missing is written again.</span>
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  item,
  onUnlink,
  onRetry,
  busy,
  writable,
}: {
  task: RelatedTask;
  item: LinkedItem;
  onUnlink: () => void;
  onRetry: () => void;
  busy: boolean;
  writable: FreshdeskWritable;
}) {
  const unlinkHint = `Unlink from this ${item.kind === "ticket" ? "ticket" : "email"}. The task stays in ClickUp.`;
  return (
    <li aria-label={task.name} className="py-2.5 border-t border-border-primary first:border-t-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-primary truncate" title={task.name}>
            {task.name}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-meta text-text-secondary">
            <TaskStatus task={task} />
            <span>{task.assignees.length > 0 ? task.assignees.join(", ") : "Unassigned"}</span>
            {task.dueAt !== null ? <DueDate at={task.dueAt} /> : <span>No due date</span>}
            {task.listName && <span className="text-text-tertiary">{task.listName}</span>}
          </div>
          <p className="mt-1 text-micro text-text-tertiary">
            {task.missing ? (
              "ClickUp no longer returns this task."
            ) : task.refreshedAt !== null ? (
              <>
                Refreshed <Timestamp at={task.refreshedAt} />
              </>
            ) : (
              "Not read from ClickUp yet"
            )}
          </p>
          <Backlinks task={task} busy={busy} writable={writable} onRetry={onRetry} />
          {task.done && (
            <p className="mt-2 text-meta text-text-secondary rounded-md border border-status-success/30 bg-status-success/5 px-2 py-1.5">
              <span className="font-medium text-text-primary">Follow up with customer:</span> this task is done in
              ClickUp. The ticket is unchanged.
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void openUrl(task.url)}
            aria-label="Open in ClickUp"
            title="Open in ClickUp"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-meta text-accent hover:bg-bg-hover"
          >
            <ExternalLink size={13} aria-hidden />
            Open in ClickUp
          </button>
          <button
            type="button"
            onClick={onUnlink}
            disabled={busy}
            aria-label={`Unlink ${task.name}`}
            title={unlinkHint}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
          >
            <Unlink size={13} aria-hidden />
          </button>
        </div>
      </div>
    </li>
  );
}

function RefreshNotice({ view }: { view: RelatedTasksView }) {
  const { message, retryAt } = view.refresh;
  if (!message) return null;
  return (
    <p role="alert" className="text-meta text-status-warning">
      {message}
      {retryAt !== null && (
        <>
          {" "}
          Next try <Timestamp at={retryAt} focusable={false} />.
        </>
      )}
    </p>
  );
}

const EMPTY_TEXT: Record<Exclude<RelatedTasksView["state"], "ready">, string> = {
  no_workspace: "Connect a ClickUp workspace in Settings → ClickUp to link tasks.",
  sample_item: "Sample ticket: tasks can be linked once a helpdesk is connected.",
};

/** The Related tasks panel: the tasks linked to a ticket or email thread, read from ClickUp. */
export function RelatedTasksPanel({ item }: { item: LinkedItem }) {
  const [view, setView] = useState<RelatedTasksView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [operationTask, setOperationTask] = useState<RelatedTask | null>(null);
  const [operationPending, setOperationPending] = useState<PendingTaskCreation | null>(null);
  const [pending, setPending] = useState<PendingTaskCreation[]>([]);
  const writable = useClickUpWritable(item);
  // The item object is rebuilt on every render; its key says when it really changed
  const key = itemKey(item);
  const itemRef = useRef(item);
  itemRef.current = item;

  const reload = useCallback(async () => {
    const current = itemRef.current;
    setView(await getRelatedTasks(current));
    setPending(await getPendingTaskCreations(current));
  }, []);

  // Show the local copy at once, then re-read tasks that are not fresh
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setPending([]);
    setError(null);
    const current = itemRef.current;
    void (async () => {
      const local = await getRelatedTasks(current);
      const unsettled = await getPendingTaskCreations(current);
      if (cancelled) return;
      setView(local);
      setPending(unsettled);
      if (local.state !== "ready" || local.tasks.length === 0) return;
      const fresh = await refreshRelatedTasks(current, { trigger: "open" });
      if (!cancelled) setView(fresh);
    })().catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [key]);

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

  const ready = view?.state === "ready";
  const linksChanged = () => window.dispatchEvent(new Event("velo-task-links-changed"));

  return (
    <section aria-label="Related tasks" className="max-w-4xl mb-6 rounded-lg border border-border-primary px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary flex-1">Related tasks</h3>
        {ready && (
          <>
            {view.tasks.length > 0 && (
              <button
                type="button"
                onClick={() => run(() => refreshRelatedTasks(item, { trigger: "manual" }))}
                disabled={busy}
                aria-label="Refresh tasks"
                title="Read the linked tasks from ClickUp again"
                className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50"
              >
                <RefreshCw size={13} className={busy ? "animate-spin" : ""} aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => setCreating(true)}
              {...writable.controlProps}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-meta text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Plus size={13} aria-hidden />
              Create task
            </button>
            <button
              type="button"
              onClick={() => setLinking(true)}
              {...writable.controlProps}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-meta text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Link2 size={13} aria-hidden />
              Link task
            </button>
          </>
        )}
      </div>
      {view && !ready && (
        <p className="text-meta text-text-tertiary">{EMPTY_TEXT[view.state as keyof typeof EMPTY_TEXT]}</p>
      )}
      {view && ready && (
        <div className="space-y-2">
          <FreshdeskWriteReason writable={writable} />
          <RefreshNotice view={view} />
          {pending.length > 0 && (
            <ul aria-label="Task creations to check" className="space-y-2">
              {pending.map((p) => (
                <li
                  key={p.operationId}
                  aria-label={p.taskName}
                  className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2"
                >
                  <p className="text-sm text-text-primary truncate" title={p.taskName}>
                    {p.taskName}
                  </p>
                  <p className="mt-0.5 text-meta text-text-secondary">{p.message}</p>
                  <button
                    type="button"
                    onClick={() => setOperationPending(p)}
                    {...writable.controlProps}
                    disabled={busy || writable.controlProps.disabled}
                    className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border-primary text-meta text-text-primary hover:bg-bg-hover disabled:opacity-50"
                  >
                    <RefreshCw size={12} aria-hidden />
                    Check ClickUp
                  </button>
                </li>
              ))}
            </ul>
          )}
          {view.tasks.length === 0 ? (
            pending.length === 0 && (
              <p className="text-meta text-text-tertiary">
                No tasks linked. Create a task, or link an existing one by search or by its URL or ID.
              </p>
            )
          ) : (
            <ul aria-label="Linked tasks">
              {view.tasks.map((task) => (
                <TaskRow
                  key={task.taskId}
                  task={task}
                  item={item}
                  busy={busy}
                  writable={writable}
                  onRetry={() => setOperationTask(task)}
                  onUnlink={() =>
                    run(async () => {
                      await unlinkTask(item, task.taskId);
                      linksChanged();
                    })
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-meta text-danger mt-2">
          {error}
        </p>
      )}
      {(operationTask || operationPending) && (
        <TaskDrawer title="ClickUp operation details" onClose={() => { setOperationTask(null); setOperationPending(null); }}>
          <div className="p-4 space-y-3">
            <FreshdeskWriteReason writable={writable} />
            {operationTask && <>
              <p className="text-sm font-medium text-text-primary">{operationTask.name}</p>
              <Backlinks task={operationTask} writable={writable} busy={busy} onRetry={() => void run(async () => {
                setOperationTask(await retryMissingBacklinks(item, operationTask.taskId));
                linksChanged();
              })} />
              {operationTask.backlinks.length === 0 && <p className="text-meta text-text-secondary">Task confirmed. The email link stays only in Velo.</p>}
            </>}
            {operationPending && <>
              <p className="text-sm font-medium text-text-primary">{operationPending.taskName}</p>
              <p className="text-meta text-text-secondary">{operationPending.message}</p>
              <button type="button" {...writable.controlProps} disabled={busy || writable.controlProps.disabled}
                className="rounded border border-separator px-3 py-2 text-sm disabled:opacity-50"
                onClick={() => void run(async () => {
                  const result = await reconcileTaskCreation(operationPending.operationId);
                  if (result.outcome === "created") {
                    setOperationPending(null); setOperationTask(result.task); linksChanged();
                  } else if (result.outcome === "unconfirmed") setOperationPending({ ...operationPending, message: result.message });
                  else throw new Error(result.message);
                })}>Check ClickUp</button>
            </>}
            {error && <p role="alert" className="text-meta text-danger">{error}</p>}
          </div>
        </TaskDrawer>
      )}
      {linking && (
        <LinkTaskDialog
          item={item}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            void reload();
            linksChanged();
          }}
        />
      )}
      {creating && (
        <CreateTaskDialog
          item={item}
          onClose={() => {
            setCreating(false);
            // A creation ClickUp never answered stays here, with Check ClickUp
            void reload();
          }}
          onCreated={() => {
            setCreating(false);
            void reload();
            linksChanged();
          }}
        />
      )}
    </section>
  );
}
