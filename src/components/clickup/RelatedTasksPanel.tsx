import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, ExternalLink, Link2, RefreshCw, Unlink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Timestamp, useDisplayTimeZone } from "@/components/ui/Timestamp";
import {
  getRelatedTasks,
  refreshRelatedTasks,
  unlinkTask,
  type LinkedItem,
  type RelatedTask,
  type RelatedTasksView,
} from "@/services/clickup/links";
import { LinkTaskDialog } from "./LinkTaskDialog";

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
  const text = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone }).format(at);
  return <span>Due {text}</span>;
}

function TaskRow({ task, onUnlink, busy }: { task: RelatedTask; onUnlink: () => void; busy: boolean }) {
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
          {task.done && (
            <p className="mt-2 text-meta text-text-secondary rounded-md border border-status-success/30 bg-status-success/5 px-2 py-1.5">
              <span className="font-medium text-text-primary">Follow up with customer:</span> this task is done in ClickUp.
              The ticket is unchanged.
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
            title="Unlink from this ticket. The task stays in ClickUp."
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
  // The item object is rebuilt on every render; its key says when it really changed
  const key = itemKey(item);
  const itemRef = useRef(item);
  itemRef.current = item;

  const reload = useCallback(async () => setView(await getRelatedTasks(itemRef.current)), []);

  // Show the local copy at once, then re-read tasks that are not fresh
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    const current = itemRef.current;
    void (async () => {
      const local = await getRelatedTasks(current);
      if (cancelled) return;
      setView(local);
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
              onClick={() => setLinking(true)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-meta text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            >
              <Link2 size={13} aria-hidden />
              Link task
            </button>
          </>
        )}
      </div>
      {view && !ready && <p className="text-meta text-text-tertiary">{EMPTY_TEXT[view.state as keyof typeof EMPTY_TEXT]}</p>}
      {view && ready && (
        <div className="space-y-2">
          <RefreshNotice view={view} />
          {view.tasks.length === 0 ? (
            <p className="text-meta text-text-tertiary">No tasks linked. Link an existing ClickUp task by search or by its URL or ID.</p>
          ) : (
            <ul aria-label="Linked tasks">
              {view.tasks.map((task) => (
                <TaskRow
                  key={task.taskId}
                  task={task}
                  busy={busy}
                  onUnlink={() =>
                    run(async () => {
                      await unlinkTask(item, task.taskId);
                      window.dispatchEvent(new Event("velo-task-links-changed"));
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
      {linking && (
        <LinkTaskDialog
          item={item}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            void reload();
            window.dispatchEvent(new Event("velo-task-links-changed"));
          }}
        />
      )}
    </section>
  );
}
