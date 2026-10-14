import { useState, type FormEvent } from "react";
import { CircleCheck, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { linkTask, searchTasksToLink, type LinkedItem, type TaskSearchResult } from "@/services/clickup/links";
import { parseTaskReference } from "@/services/clickup/tasks";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * Links an existing ClickUp task: search by name, or paste a task URL or ID.
 * Either way the task is verified through ClickUp before the link is stored.
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaskSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = async (reference: string | { taskId: string }) => {
    setBusy(true);
    setError(null);
    try {
      await linkTask(item, reference);
      onLinked();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = query.trim();
    if (!text || busy) return;
    if (parseTaskReference(text)) {
      await link(text);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResults(await searchTasksToLink(item, text));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Link a ClickUp task" width="w-[32rem]">
      <div role="dialog" aria-label="Link a ClickUp task" className="p-4 space-y-3">
        <form onSubmit={(e) => void handleSubmit(e)} className="flex items-end gap-2">
          <div className="flex-1">
            <TextField
              label="Search tasks or paste a task URL or ID"
              size="md"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Task name, https://app.clickup.com/t/… or a task ID"
              autoComplete="off"
              autoFocus
            />
          </div>
          <Button type="submit" variant="primary" size="md" disabled={busy || !query.trim()}>
            <Search size={14} aria-hidden />
            {busy ? "Checking…" : "Find"}
          </Button>
        </form>
        <p className="text-micro text-text-tertiary">
          Velo checks the task with ClickUp before linking. Linking writes nothing to ClickUp or Freshdesk.
        </p>
        {error && (
          <p role="alert" className="text-meta text-danger">
            {error}
          </p>
        )}
        {results !== null &&
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
                  <Button size="sm" variant="secondary" disabled={busy || r.alreadyLinked} onClick={() => void link({ taskId: r.taskId })}>
                    {r.alreadyLinked ? "Linked" : "Link"}
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Modal>
  );
}
