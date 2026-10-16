import { useEffect, useRef, useState } from "react";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { Button } from "@/components/ui/Button";
import { useAiReadiness } from "@/components/freshdesk/TicketSummaryCard";
import type { LinkedItem } from "@/services/clickup/links";
import { loadTaskAiSource } from "@/services/clickup/taskAi";
import { proposeTaskText } from "@/services/freshdesk/ticketAi";

export interface TaskText {
  title: string;
  description: string;
}
export interface TaskProposalControls {
  locked: boolean;
  onApply: (text: TaskText, how: "replace" | "insert") => void;
}

/** A separate, editable proposal; the dialog's text changes only by choice. */
export function TaskProposalPanel({ item, locked, onApply }: TaskProposalControls & { item: LinkedItem }) {
  const readiness = useAiReadiness();
  const [proposal, setProposal] = useState<TaskText | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  useEffect(() => () => { run.current++; }, []);
  if (readiness?.status !== "ready") return null;

  async function generate() {
    const mine = ++run.current;
    setLoading(true);
    setError(null);
    try {
      const source = await loadTaskAiSource(item);
      if (run.current !== mine) return;
      const text = await proposeTaskText(source);
      if (run.current === mine) setProposal({
        title: text.title,
        description: [text.summary, text.acceptanceCriteria.length ? `Acceptance criteria:\n${text.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
      });
    } catch (err) {
      if (run.current === mine) setError(err instanceof Error ? err.message : "AI proposal unavailable. You can still write the task yourself.");
    } finally {
      if (run.current === mine) setLoading(false);
    }
  }

  const apply = (how: "replace" | "insert") => {
    if (!proposal) return;
    onApply(proposal, how);
    setProposal(null);
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="xs" disabled={locked || loading || proposal !== null} onClick={() => void generate()}>
        {loading ? "Proposing…" : "Propose task text"}
      </Button>
      {loading && <Button type="button" size="xs" onClick={() => { run.current++; setLoading(false); }}>Cancel proposal</Button>}
      <AiSendNote features={["task_proposal"]} />
    </div>
    {error && <p role="status" className="text-meta text-text-secondary">{error}</p>}
    {proposal && <section aria-label="AI task proposal" className="rounded-md border border-dashed border-accent/50 p-3 space-y-2">
      <p className="text-meta text-text-secondary">AI proposal · check and edit before using. Nothing is created.</p>
      <label className="block text-meta text-text-secondary">Proposed title
        <input value={proposal.title} disabled={locked} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} className="block w-full rounded border border-border-primary bg-bg-primary p-2 text-text-primary" />
      </label>
      <label className="block text-meta text-text-secondary">Proposed description
        <textarea value={proposal.description} disabled={locked} rows={5} onChange={(e) => setProposal({ ...proposal, description: e.target.value })} className="block w-full rounded border border-border-primary bg-bg-primary p-2 text-text-primary" />
      </label>
      <div className="flex gap-2">
        <Button type="button" size="xs" disabled={locked} onClick={() => apply("replace")}>Replace</Button>
        <Button type="button" size="xs" disabled={locked} onClick={() => apply("insert")}>Insert</Button>
        <Button type="button" size="xs" onClick={() => setProposal(null)}>Discard</Button>
      </div>
      <p className="text-micro text-text-tertiary">Your title and description stay as they are until you choose.</p>
    </section>}
  </div>;
}
