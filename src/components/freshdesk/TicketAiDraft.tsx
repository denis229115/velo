import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AiSendNote } from "@/components/ai/AiSendPreview";
import { APPROVED_PROVIDER_LABEL } from "@/services/ai/gateway";
import { AiError } from "@/services/ai/errors";
import type { TicketListItem } from "@/services/freshdesk/ticketSync";
import type { TicketHistoryView } from "@/services/freshdesk/ticketHistory";
import { REPLY_TONES, draftTicketReply, type DraftAction, type ReplyTone } from "@/services/freshdesk/ticketAi";
import { ticketAiSource, useAiReadiness } from "./TicketSummaryCard";

const NOT_SENT_CODES = new Set(["CANCELLED", "PREVIEW_REQUIRED", "SENSITIVE_DATA", "NOT_CONFIGURED", "NOT_APPROVED", "PROVIDER_REFUSED"]);
const WORKING: Record<DraftAction, string> = { draft: "Drafting", rewrite: "Rewriting", shorten: "Shortening" };

type State =
  | { kind: "idle" }
  | { kind: "loading"; action: DraftAction }
  | { kind: "proposal"; html: string }
  | { kind: "failed"; message: string };

/**
 * AI draft for a reply: draft from the ticket, or rewrite or shorten what the
 * operator wrote, in the chosen tone. The result is a proposal; it enters the
 * editor only through Use draft (empty reply), Replace or Insert, so the
 * operator's own text is never overwritten silently. Nothing is ever sent.
 * With AI off the bar is absent and the composer works as usual.
 */
export function TicketAiDraft({
  ticket,
  view,
  editor,
  empty,
}: {
  ticket: TicketListItem;
  view: TicketHistoryView | null;
  editor: Editor | null;
  empty: boolean;
}) {
  const readiness = useAiReadiness();
  const [tone, setTone] = useState<ReplyTone>("friendly_professional");
  const [state, setState] = useState<State>({ kind: "idle" });
  const run = useRef(0);

  useEffect(() => () => void run.current++, []);

  if (readiness?.status !== "ready" || !editor) return null;

  async function generate(action: DraftAction) {
    if (!view || !editor) return;
    const mine = ++run.current;
    setState({ kind: "loading", action });
    try {
      const html = await draftTicketReply(ticketAiSource(ticket, view), {
        tone,
        action,
        ...(action !== "draft" && { draftText: editor.getText({ blockSeparator: "\n\n" }) }),
      });
      if (run.current === mine) setState({ kind: "proposal", html });
    } catch (err) {
      if (run.current !== mine) return;
      setState({
        kind: "failed",
        message:
          err instanceof AiError && NOT_SENT_CODES.has(err.code)
            ? err.message
            : "AI draft unavailable right now. Your reply is not affected.",
      });
    }
  }

  function take(how: "replace" | "insert") {
    if (state.kind !== "proposal" || !editor) return;
    if (how === "replace") editor.chain().focus().setContent(state.html).run();
    else editor.chain().focus().insertContent(state.html).run();
    setState({ kind: "idle" });
  }

  const loading = state.kind === "loading";
  const locked = !editor.isEditable;

  return (
    <div className="mx-3 mt-2 space-y-2">
      <div role="group" aria-label="AI draft tools" className="flex flex-wrap items-center gap-2">
        <Sparkles size={13} aria-hidden className="shrink-0 text-accent" />
        <label className="inline-flex items-center gap-1.5 text-meta text-text-secondary">
          Tone
          <select
            aria-label="Tone"
            value={tone}
            onChange={(e) => setTone(e.target.value as ReplyTone)}
            className="rounded-md border border-border-primary bg-bg-primary px-1.5 py-0.5 text-meta text-text-primary"
          >
            {REPLY_TONES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" size="xs" className="border border-border-primary" disabled={loading || locked || !view} onClick={() => void generate("draft")}>
          Draft reply
        </Button>
        <Button variant="ghost" size="xs" disabled={loading || locked || empty || !view} onClick={() => void generate("rewrite")}>
          Rewrite
        </Button>
        <Button variant="ghost" size="xs" disabled={loading || locked || empty || !view} onClick={() => void generate("shorten")}>
          Shorten
        </Button>
        {loading ? (
          <span className="ml-auto inline-flex items-center gap-2">
            <span role="status" className="inline-flex items-center gap-1.5 text-meta text-text-tertiary">
              <span className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" aria-hidden />
              {WORKING[state.action]} with {APPROVED_PROVIDER_LABEL}…
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                run.current++;
                setState({ kind: "idle" });
              }}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <span className="ml-auto">
            <AiSendNote features={["ticket_reply"]} />
          </span>
        )}
      </div>

      {state.kind === "failed" && (
        <p role="status" className="text-meta text-text-secondary">
          {state.message}
        </p>
      )}

      {state.kind === "proposal" && (
        <section aria-label="AI draft" className="rounded-md border border-dashed border-accent/50 bg-accent/5">
          <p className="px-3 pt-2 text-micro font-medium uppercase tracking-wide text-text-tertiary">
            AI draft · check it before you use it; nothing is sent
          </p>
          <div
            className="prose prose-sm max-w-none px-3 py-2 text-text-primary"
            // Sanitised by the Ticket AI service before it gets here
            dangerouslySetInnerHTML={{ __html: state.html }}
          />
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
            {empty ? (
              <Button variant="primary" size="xs" disabled={locked} onClick={() => take("replace")}>
                Use draft
              </Button>
            ) : (
              <>
                <Button variant="primary" size="xs" disabled={locked} title="Replace your text with this draft" onClick={() => take("replace")}>
                  Replace
                </Button>
                <Button variant="secondary" size="xs" className="border border-border-primary" disabled={locked} title="Insert this draft at the cursor, keeping your text" onClick={() => take("insert")}>
                  Insert
                </Button>
              </>
            )}
            <Button variant="ghost" size="xs" onClick={() => setState({ kind: "idle" })}>
              Discard
            </Button>
            {!empty && <span className="text-micro text-text-tertiary">Your text stays as it is until you choose.</span>}
          </div>
        </section>
      )}
    </div>
  );
}
