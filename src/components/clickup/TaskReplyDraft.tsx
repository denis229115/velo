import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { Button } from "@/components/ui/Button";
import { useAiReadiness } from "@/components/freshdesk/TicketSummaryCard";
import { getRelatedTasks, type LinkedItem, type RelatedTask } from "@/services/clickup/links";
import { loadTaskAiSource } from "@/services/clickup/taskAi";
import { readTaskForAi } from "@/services/clickup/taskContent";
import { draftReplyFromTask } from "@/services/freshdesk/ticketAi";

/** Replies remain proposals until explicitly inserted or replaced; never sent here. */
export function TaskReplyDraft({ item, editor, disabled = false }: { item: LinkedItem; editor: Editor | null; disabled?: boolean }) {
  const readiness = useAiReadiness();
  const [tasks, setTasks] = useState<RelatedTask[]>([]);
  const [taskId, setTaskId] = useState("");
  const [loading, setLoading] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const kind = item.kind;
  const scope = item.kind === "email" ? item.accountId : "";
  const id = item.kind === "email" ? item.threadId : item.ticketId;

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const related = await getRelatedTasks(item);
        if (!active) return;
        const available = related.tasks.filter((t) => !t.missing);
        setTasks(available);
        setTaskId((chosen) => available.some((t) => t.taskId === chosen) ? chosen : available[0]?.taskId ?? "");
      } catch { if (active) setTasks([]); }
    };
    void load();
    const changed = () => { run.current++; setHtml(null); setLoading(false); void load(); };
    window.addEventListener("velo-task-links-changed", changed);
    return () => { active = false; run.current++; window.removeEventListener("velo-task-links-changed", changed); };
    // Item identity, rather than the caller's object allocation, owns the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, scope, id]);

  if (readiness?.status !== "ready" || !editor || tasks.length === 0) return null;
  const locked = disabled || !editor.isEditable;

  async function generate() {
    if (!taskId || locked) return;
    const mine = ++run.current;
    setLoading(true);
    setError(null);
    setHtml(null);
    try {
      // Recheck the link before reading remote task content.
      if (!(await getRelatedTasks(item)).tasks.some((t) => t.taskId === taskId && !t.missing)) throw new Error("This task is no longer linked.");
      const source = await loadTaskAiSource(item);
      const task = await readTaskForAi(taskId);
      if (run.current !== mine) return;
      const result = await draftReplyFromTask(source, task);
      if (run.current === mine) setHtml(result);
    } catch (err) {
      if (run.current === mine) setError(err instanceof Error ? err.message : "AI draft unavailable. Your reply is not affected.");
    } finally { if (run.current === mine) setLoading(false); }
  }
  function apply(how: "replace" | "insert") {
    if (!editor || html === null || locked) return;
    if (how === "replace") editor.chain().focus().setContent(html).run();
    else editor.chain().focus().insertContent(html).run();
    setHtml(null);
  }

  return <div className="mx-3 my-2 space-y-2">
    <div role="group" aria-label="Reply from linked task" className="flex flex-wrap items-center gap-2">
      <label className="text-meta text-text-secondary">Linked task for reply
        <select value={taskId} disabled={locked || loading} onChange={(e) => { run.current++; setTaskId(e.target.value); setHtml(null); }} className="ml-2 rounded border border-border-primary bg-bg-primary px-2 py-1 text-text-primary">
          {tasks.map((t) => <option key={t.taskId} value={t.taskId}>{t.name} · {t.status}</option>)}
        </select>
      </label>
      <Button type="button" size="xs" disabled={locked || loading || !taskId} onClick={() => void generate()}>{loading ? "Drafting from task…" : "Draft from task"}</Button>
      {loading && <Button type="button" size="xs" onClick={() => { run.current++; setLoading(false); }}>Cancel task draft</Button>}
      <AiSendNote features={["task_reply"]} />
    </div>
    {error && <p role="status" className="text-meta text-text-secondary">{error}</p>}
    {html !== null && <section aria-label="Task reply draft" className="rounded-md border border-dashed border-accent/50 p-3 space-y-2">
      <p className="text-meta text-text-secondary">AI draft · verify progress before using. Sending stays manual.</p>
      <div className="prose prose-sm text-text-primary" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="flex gap-2">
        <Button type="button" size="xs" disabled={locked} onClick={() => apply("replace")}>Replace</Button>
        <Button type="button" size="xs" disabled={locked} onClick={() => apply("insert")}>Insert</Button>
        <Button type="button" size="xs" onClick={() => setHtml(null)}>Discard</Button>
      </div>
    </section>}
  </div>;
}
