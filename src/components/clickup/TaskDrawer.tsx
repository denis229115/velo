import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** Shared by create, link and operation details; leaves the reader's header visible. */
export function TaskDrawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  // Capture before child autoFocus runs during commit.
  const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose);
  close.current = onClose;
  const id = useId();
  const [top, setTop] = useState(84);

  useLayoutEffect(() => {
    const opener = openerRef.current;
    const reader = anchor.current?.closest('[data-clickup-reader]') ?? opener?.closest('[data-clickup-reader]');
    const header = reader?.querySelector('[data-clickup-drawer-header]');
    const position = () => setTop(Math.max(36, header?.getBoundingClientRect().bottom ?? 84));
    position();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (header) resize?.observe(header);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    // A send preview can open above this drawer. Its existing Modal owns Escape.
    const scope = () => {
      const modals = document.querySelectorAll<HTMLElement>("[data-modal-root]");
      return modals[modals.length - 1] ?? panel.current!;
    };
    const focusables = () => [...scope().querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden], [aria-hidden="true"]')).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const focusFirst = () => (focusables()[0] ?? scope()).focus();
    let lastScope = scope();
    let returnWithin: HTMLElement | null = null;
    focusFirst();
    const observer = new MutationObserver(() => {
      const current = scope();
      if (lastScope === current) return;
      lastScope = current;
      if (current === panel.current && returnWithin?.isConnected) returnWithin.focus();
      else focusFirst();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const onFocus = (e: FocusEvent) => {
      if (!scope().contains(e.target as Node)) focusFirst();
      if (panel.current?.contains(e.target as Node)) returnWithin = e.target as HTMLElement;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && scope() === panel.current) {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
      if (e.key !== "Tab") return;
      const nodes = focusables();
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first) { e.preventDefault(); scope().focus(); }
      else if (!scope().contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
      else reader?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    };
  }, []);

  return <><span ref={anchor} hidden />{createPortal(
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
      style={{ top }}
      className="fixed right-0 bottom-0 z-40 w-[420px] max-w-full max-sm:w-full flex flex-col bg-surface-overlay border-l border-separator overlay-shadow text-text-primary"
      onContextMenu={(e) => e.stopPropagation()}>
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-separator">
        <h3 id={id} className="text-sm font-semibold">{title}</h3>
        <button type="button" aria-label={`Close ${title}`} onClick={onClose} className="px-2 text-lg text-text-secondary hover:text-text-primary">×</button>
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>, document.body,
  )}</>;
}
