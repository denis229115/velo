import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleCheck, Link2, Search } from "lucide-react";
import { TaskDrawer } from "./TaskDrawer";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { FreshdeskWriteReason } from "@/components/freshdesk/useFreshdeskWritable";
import { BACKLINK_LABELS } from "@/services/clickup/backlinks";
import { BACKLINK_STEPS } from "@/services/db/taskLinks";
import { linkTask, searchTasksToLink, type LinkedItem, type TaskSearchResult } from "@/services/clickup/links";
import { parseTaskReference } from "@/services/clickup/tasks";
import { useClickUpWritable } from "./useClickUpWritable";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

type TaskChoice = { reference: string | { taskId: string }; label: string };

/** What linking to a ticket writes, shown before anything is written */
function ConfirmLink({
  choice,
  busy,
  disabled,
  onConfirm,
  onBack,
}: {
  choice: TaskChoice;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Confirm the link"
      className="rounded-md border border-border-primary px-3 py-2.5 space-y-2"
    >
      <p className="text-sm text-text-primary">
        Link <span className="font-medium">{choice.label}</span> to this ticket?
      </p>
      <p className="text-meta text-text-secondary">Velo checks the task with ClickUp, then writes these backlinks:</p>
      <ul aria-label="Backlinks Velo writes" className="list-disc pl-5 text-meta text-text-primary">
        {BACKLINK_STEPS.map((step) => (
          <li key={step}>{BACKLINK_LABELS[step]}</li>
        ))}
      </ul>
      <p className="text-micro text-text-tertiary">
        If the task's list has no Ticket-ID field, or the field holds another ticket, that step is skipped and Velo says
        so.
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button size="sm" variant="primary" onClick={onConfirm} disabled={busy || disabled}>
          <Link2 size={13} aria-hidden />
          {busy ? "Linking…" : "Link and write backlinks"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Links an existing ClickUp task: search by name, or paste a task URL or ID.
 * Either way the task is verified through ClickUp before the link is stored.
 * A ticket link writes three backlinks, so it is confirmed first; an email
 * link writes nothing outside Velo and is stored at once.
 */
export function LinkTaskDialog({
  item,
  onClose,
  onLinked,
}: {
  item: LinkedItem;
  onClose: () => void;
  onLinked: () => void;
}) {
  const generation = useRef(0);
  const [connectionChanged, setConnectionChanged] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaskSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TaskChoice | null>(null);
  const writable = useClickUpWritable(item);

  useEffect(() => {
    const changed = () => {
      generation.current++;
      setConnectionChanged(true);
      setConfirming(null);
      setResults(null);
      setBusy(false);
      setError("The ClickUp connection changed. Close and reopen the drawer.");
    };
    window.addEventListener("velo-clickup-connection-changed", changed);
    return () => { generation.current++; window.removeEventListener("velo-clickup-connection-changed", changed); };
  }, []);

  const choose = (choice: TaskChoice) => {
    if (connectionChanged || busy || writable.controlProps.disabled) return;
    setError(null);
    if (item.kind === "ticket") setConfirming(choice);
    else void link(choice.reference);
  };

  const link = async (reference: string | { taskId: string }) => {
    if (connectionChanged || busy || writable.controlProps.disabled) return;
    const mine = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      await linkTask(item, reference);
      if (mine === generation.current) onLinked();
    } catch (err) {
      if (mine === generation.current) setError(errorMessage(err));
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = query.trim();
    if (!text || busy || connectionChanged || writable.controlProps.disabled) return;
    if (parseTaskReference(text)) {
      choose({ reference: text, label: text });
      return;
    }
    const mine = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const results = await searchTasksToLink(item, text);
      if (mine === generation.current) setResults(results);
    } catch (err) {
      if (mine === generation.current) setError(errorMessage(err));
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };

  return (
    <TaskDrawer onClose={onClose} title="Link a ClickUp task">
      <div className="p-4 space-y-3">
        <form onSubmit={(e) => void handleSubmit(e)} className="flex items-end gap-2">
          <div className="flex-1">
            <TextField
              label="Search tasks or paste a task URL or ID"
              size="md"
              value={query}
              disabled={busy || confirming !== null || connectionChanged}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Task name, https://app.clickup.com/t/… or a task ID"
              autoComplete="off"
              autoFocus
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            size="md"
            {...writable.controlProps}
            disabled={busy || connectionChanged || !query.trim() || writable.controlProps.disabled || confirming !== null}
          >
            <Search size={14} aria-hidden />
            {busy ? "Checking…" : "Find"}
          </Button>
        </form>
        <p className="text-micro text-text-tertiary">
          {item.kind === "ticket"
            ? "Velo checks the task with ClickUp before linking, and asks before it writes the backlinks."
            : "Velo checks the task with ClickUp before linking. Nothing from this email is written to ClickUp."}
        </p>
        <FreshdeskWriteReason writable={writable} />
        {confirming && (
          <ConfirmLink
            choice={confirming}
            busy={busy}
            disabled={connectionChanged || writable.controlProps.disabled}
            onBack={() => setConfirming(null)}
            onConfirm={() => void link(confirming.reference)}
          />
        )}
        {error && (
          <p role="alert" className="text-meta text-danger">
            {error}
          </p>
        )}
        {results !== null &&
          !confirming &&
          (results.length === 0 ? (
            <p className="text-meta text-text-tertiary">No task names in the workspace match “{query.trim()}”.</p>
          ) : (
            <ul aria-label="Matching tasks" className="max-h-72 overflow-y-auto">
              {results.map((r) => (
                <li
                  key={r.taskId}
                  aria-label={r.name}
                  className="flex items-center gap-3 py-2 border-t border-border-primary first:border-t-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-primary truncate" title={r.name}>
                      {r.name}
                    </p>
                    <p className="text-micro text-text-tertiary truncate">
                      {r.status}
                      {r.done && (
                        <>
                          {" "}
                          <CircleCheck size={10} className="inline text-status-success" aria-label="done" />
                        </>
                      )}
                      {r.listName ? ` · ${r.listName}` : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || connectionChanged || r.alreadyLinked || writable.controlProps.disabled}
                    onClick={() => choose({ reference: { taskId: r.taskId }, label: r.name })}
                  >
                    {r.alreadyLinked ? "Linked" : "Link"}
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </TaskDrawer>
  );
}
