import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleCheck, Link2, ListChecks, Plus } from "lucide-react";
import { navigateToSettings } from "@/router/navigate";
import { getRelatedTasks, refreshRelatedTasks, type LinkedItem, type RelatedTasksView } from "@/services/clickup/links";
import { getPendingTaskCreations } from "@/services/clickup/taskCreate";
import { FreshdeskWriteReason } from "@/components/freshdesk/useFreshdeskWritable";
import { CreateTaskDialog } from "./CreateTaskDialog";
import { LinkTaskDialog } from "./LinkTaskDialog";
import { RelatedTasksPanel } from "./RelatedTasksPanel";
import { useClickUpWritable } from "./useClickUpWritable";

const ROW = "flex items-center gap-2 min-h-8 max-w-4xl rounded-md border border-border-primary px-3 py-1 text-meta";
const ACTION =
  "inline-flex items-center gap-1 shrink-0 rounded-md px-2 py-1 text-meta text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 disabled:hover:bg-transparent";

/**
 * A ticket's or email thread's linked ClickUp work as one slim row: the count,
 * Create task, Link task, and the full Related tasks list on request. An email
 * thread shows nothing until a ClickUp workspace is connected.
 */
export function LinkedWorkRow({ item }: { item: LinkedItem }) {
  const [view, setView] = useState<RelatedTasksView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const writable = useClickUpWritable(item);
  const panelId = useId();
  // The item object is rebuilt on every render; its key says when it really changed
  const key = item.kind === "ticket" ? `ticket:${item.ticketId}` : `email:${item.accountId}:${item.threadId}`;
  const itemRef = useRef(item);
  itemRef.current = item;

  const reload = useCallback(async () => setView(await getRelatedTasks(itemRef.current)), []);

  // The local copy at once, then tasks that are not fresh, as the Related tasks panel does
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setExpanded(false);
    const current = itemRef.current;
    void (async () => {
      const local = await getRelatedTasks(current);
      if (cancelled) return;
      setView(local);
      if (local.state !== "ready" || local.tasks.length === 0) return;
      const fresh = await refreshRelatedTasks(current, { trigger: "open" });
      if (!cancelled) setView(fresh);
    })().catch(() => {});
    const onChange = () => void getRelatedTasks(current).then((v) => !cancelled && setView(v));
    window.addEventListener("velo-task-links-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("velo-task-links-changed", onChange);
    };
  }, [key]);

  if (!view) return item.kind === "ticket" ? <section aria-label="Linked work" className="h-8" /> : null;

  if (view.state === "no_workspace") {
    if (item.kind === "email") return null;
    return (
      <section aria-label="Linked work" className={`${ROW} text-text-tertiary`}>
        <ListChecks size={13} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1">No ClickUp workspace connected.</span>
        <button type="button" onClick={() => navigateToSettings("clickup")} className={ACTION}>
          Connect ClickUp
        </button>
      </section>
    );
  }

  if (view.state === "sample_item") {
    return (
      <section aria-label="Linked work" className={`${ROW} text-text-tertiary`}>
        <ListChecks size={13} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1">Sample ticket: tasks can be linked once a helpdesk is connected.</span>
      </section>
    );
  }

  const count = view.tasks.length;
  const done = view.tasks.filter((t) => t.done).length;
  const missingBacklinks = view.tasks.some((t) => t.backlinks.some((b) => b.state !== "done" && b.state !== "skipped"));
  const linksChanged = () => {
    setExpanded(true);
    void reload();
    window.dispatchEvent(new Event("velo-task-links-changed"));
  };
  return (
    <section aria-label="Linked work">
      {/* A narrow reader wraps the actions under the count rather than squeezing it out */}
      <div className={`${ROW} flex-wrap`}>
        <ListChecks size={13} aria-hidden className="shrink-0 text-text-tertiary" />
        <span className="shrink-0 text-text-tertiary">ClickUp</span>
        {count === 0 ? (
          <span className="flex-1 whitespace-nowrap text-text-secondary">No linked tasks</span>
        ) : (
          <span data-testid="linked-work-count" className="flex-1 whitespace-nowrap text-text-primary tabular-nums">
            {count} task{count === 1 ? "" : "s"} · {done} done
          </span>
        )}
        {done > 0 && !expanded && (
          // The Follow-up cue stays visible with the list closed; it never changes the ticket
          <span
            title="A linked task is done in ClickUp. The ticket is unchanged."
            className="inline-flex items-center gap-1 shrink-0 text-status-success"
          >
            <CircleCheck size={12} aria-hidden />
            Follow up with customer
          </span>
        )}
        {missingBacklinks && !expanded && (
          <span
            title="A backlink was not written. Show tasks to retry it."
            className="inline-flex items-center gap-1 shrink-0 text-status-warning"
          >
            <AlertTriangle size={12} aria-hidden />
            Backlink missing
          </span>
        )}
        {!expanded && (
          <>
            <button type="button" onClick={() => setCreating(true)} {...writable.controlProps} className={ACTION}>
              <Plus size={13} aria-hidden />
              Create task
            </button>
            <button type="button" onClick={() => setLinking(true)} {...writable.controlProps} className={ACTION}>
              <Link2 size={13} aria-hidden />
              Link task
            </button>
            <FreshdeskWriteReason writable={writable} className="sr-only" />
          </>
        )}
        {(count > 0 || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((e) => !e)}
            className={ACTION}
          >
            {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            {expanded ? "Hide tasks" : "Show tasks"}
          </button>
        )}
      </div>
      {expanded && (
        <div id={panelId} className="mt-2 [&>section]:mb-0">
          <RelatedTasksPanel item={item} />
        </div>
      )}
      {linking && (
        <LinkTaskDialog
          item={item}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            linksChanged();
          }}
        />
      )}
      {creating && (
        <CreateTaskDialog
          item={item}
          onClose={() => {
            setCreating(false);
            // A creation ClickUp never answered is settled from the full list, with Check ClickUp
            void getPendingTaskCreations(item).then((p) => p.length > 0 && setExpanded(true));
          }}
          onCreated={() => {
            setCreating(false);
            linksChanged();
          }}
        />
      )}
    </section>
  );
}
