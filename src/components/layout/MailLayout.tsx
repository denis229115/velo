import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { EmailList } from "./EmailList";
import { ReadingPane } from "./ReadingPane";
import { ThreadView } from "../email/ThreadView";
import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerStore } from "@/stores/composerStore";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { useSelectedThreadId } from "@/hooks/useRouteNavigation";
import { navigateBack } from "@/router/navigate";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

function ResizableEmailLayout() {
  const emailListWidth = useUIStore((s) => s.emailListWidth);
  const setEmailListWidth = useUIStore((s) => s.setEmailListWidth);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = listRef.current?.offsetWidth ?? emailListWidth;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.min(800, Math.max(240, startWidth + delta));
      if (listRef.current) listRef.current.style.width = `${newWidth}px`;
    };

    const handleMouseUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const delta = ev.clientX - startX;
      const finalWidth = Math.min(800, Math.max(240, startWidth + delta));
      setEmailListWidth(finalWidth);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [emailListWidth, setEmailListWidth]);

  return (
    <div ref={containerRef} className="flex flex-1 min-w-0 flex-row">
      <ErrorBoundary name="EmailList">
        <EmailList width={emailListWidth} listRef={listRef} />
      </ErrorBoundary>
      <div
        onMouseDown={handleMouseDown}
        className="relative w-px cursor-col-resize bg-border-primary hover:bg-accent/50 active:bg-accent transition-colors shrink-0 after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']"
      />
      <ErrorBoundary name="ReadingPane">
        <ReadingPane />
      </ErrorBoundary>
    </div>
  );
}

/**
 * Click-to-open reader. The list stays mounted underneath.
 * z-40 is under the composer (z-50) so a reply still covers the thread.
 * Escape follows nav.escape (composer, multi-select, then back) and stops
 * before the global shortcut can navigate back a second time.
 */
function HiddenThreadOverlay() {
  const selectedThreadId = useSelectedThreadId();
  const thread = useThreadStore((s) =>
    selectedThreadId ? (s.threadMap.get(selectedThreadId) ?? null) : null,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const openThreadId = thread?.id ?? null;

  useEffect(() => {
    if (!openThreadId) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Same owners as nav.escape: a menu, the composer, a multi-select, a
      // nested dialog, or text the operator is editing keep the thread open.
      if (useContextMenuStore.getState().menuType) return;
      if (useComposerStore.getState().isOpen) return;
      if (useThreadStore.getState().selectedThreadIds.size > 0) return;
      if (document.querySelector("[data-modal-root]")) return;
      if (document.querySelector('[role="dialog"]:not([data-mail-reader])')) return;
      const target = e.target;
      if (target instanceof HTMLElement && (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" ||
        target.isContentEditable || target.closest("[contenteditable='true']")
      )) return;
      e.preventDefault();
      e.stopPropagation();
      navigateBack();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [openThreadId]);

  if (!thread) return null;

  const subject = thread.subject ?? "(No subject)";

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-40 flex p-4">
      <div
        className="pointer-events-auto absolute inset-0 backdrop-animate"
        onClick={() => navigateBack()}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={subject}
        data-mail-reader=""
        tabIndex={-1}
        className="pointer-events-auto relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-primary bg-surface-reader overlay-shadow"
      >
        <div className="flex shrink-0 items-center justify-end border-b border-border-primary bg-bg-secondary px-2 py-1.5">
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={() => navigateBack()}
            className="p-1 text-lg leading-none text-text-tertiary hover:text-text-primary"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary name="ReadingPane">
            <ThreadView thread={thread} />
          </ErrorBoundary>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function MailLayout() {
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);

  if (readingPanePosition === "right") {
    return <ResizableEmailLayout />;
  }

  return (
    <div className={`flex flex-1 min-w-0 ${readingPanePosition === "bottom" ? "flex-col" : "flex-row"}`}>
      <ErrorBoundary name="EmailList">
        <EmailList />
      </ErrorBoundary>
      {readingPanePosition === "bottom" && (
        <ErrorBoundary name="ReadingPane">
          <ReadingPane />
        </ErrorBoundary>
      )}
      {readingPanePosition === "hidden" && <HiddenThreadOverlay />}
    </div>
  );
}
