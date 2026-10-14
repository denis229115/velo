import { useCallback, useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, Link2, ListChecks } from "lucide-react";
import { navigateToSettings } from "@/router/navigate";
import { getRelatedTasks, refreshRelatedTasks, type LinkedItem, type RelatedTasksView } from "@/services/clickup/links";
import { LinkTaskDialog } from "./LinkTaskDialog";
import { RelatedTasksPanel } from "./RelatedTasksPanel";

const ROW = "flex items-center gap-2 min-h-8 max-w-4xl rounded-md border border-border-primary px-3 py-1 text-meta";
const ACTION =
  "inline-flex items-center gap-1 shrink-0 rounded-md px-2 py-1 text-meta text-text-secondary hover:text-text-primary hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent";

/**
 * A ticket's linked ClickUp work as one slim row: the count, Link task, and the
 * full Related tasks list on request.
 */
export function LinkedWorkRow({ item }: { item: Extract<LinkedItem, { kind: "ticket" }> }) {
  const [view, setView] = useState<RelatedTasksView | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const panelId = useId();
  const { ticketId } = item;

  const reload = useCallback(async () => setView(await getRelatedTasks({ kind: "ticket", ticketId })), [ticketId]);

  // The local copy at once, then tasks that are not fresh, as the Related tasks panel does
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setExpanded(false);
    const current = { kind: "ticket" as const, ticketId };
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
  }, [ticketId]);

  if (!view) return <section aria-label="Linked work" className="h-8" />;

  if (view.state === "no_workspace") {
    return (
      <section aria-label="Linked work" className={`${ROW} text-text-tertiary`}>
        <ListChecks size={13} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">Link ClickUp tasks to this ticket once a workspace is connected.</span>
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
        <span className="min-w-0 flex-1 truncate">Sample ticket: tasks can be linked once a helpdesk is connected.</span>
      </section>
    );
  }

  const count = view.tasks.length;
  const done = view.tasks.filter((t) => t.done).length;
  return (
    <section aria-label="Linked work">
      <div className={ROW}>
        <ListChecks size={13} aria-hidden className="shrink-0 text-text-tertiary" />
        <span className="shrink-0 text-text-tertiary">ClickUp</span>
        {count === 0 ? (
          <span className="min-w-0 flex-1 truncate text-text-secondary">No linked tasks</span>
        ) : (
          <span data-testid="linked-work-count" className="min-w-0 flex-1 truncate text-text-primary tabular-nums">
            {count} task{count === 1 ? "" : "s"} · {done} done
          </span>
        )}
        {!expanded && (
          <button type="button" onClick={() => setLinking(true)} className={ACTION}>
            <Link2 size={13} aria-hidden />
            Link task
          </button>
        )}
        {count > 0 && (
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
        <div id={panelId} className="mt-2">
          <RelatedTasksPanel item={item} />
        </div>
      )}
      {linking && (
        <LinkTaskDialog
          item={item}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            setExpanded(true);
            void reload();
            window.dispatchEvent(new Event("velo-task-links-changed"));
          }}
        />
      )}
    </section>
  );
}
