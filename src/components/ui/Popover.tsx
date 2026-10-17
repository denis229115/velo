import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { focusableIn, trapTabKey } from "./focusTrap";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Anchors the panel under this element. Without one, the panel is centered. */
  anchorRef?: RefObject<HTMLElement | null>;
  width?: number;
}

export function Popover({ open, onClose, title, children, anchorRef, width = 320 }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const box = useAnchorBox(open, anchorRef, width);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      (focusableIn(panel)[0] ?? panel).focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
      returnTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const panel = panelRef.current;
      if (panel) trapTabKey(event, panel);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="material-pop rounded-[var(--radius-menu)] text-text-primary outline-none"
      style={
        box
          ? { position: "fixed", top: box.top, left: box.left, width, zIndex: 70 }
          : { position: "relative", width, zIndex: 70 }
      }
      onMouseDown={(event) => event.stopPropagation()}
    >
      <h2 id={titleId} className="px-3 pt-3 pb-1 text-preview font-medium text-text-primary">
        {title}
      </h2>
      {children}
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0" onMouseDown={onClose} />
      {box ? panel : <div className="absolute inset-0 flex items-start justify-center pt-[12vh]">{panel}</div>}
    </div>,
    document.body,
  );
}

function useAnchorBox(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null> | undefined,
  width: number,
): { top: number; left: number } | null {
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef?.current;
      if (!anchor) {
        setBox(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const top = Math.min(rect.bottom + 6, window.innerHeight - 16);
      setBox({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchorRef, width]);
  return open ? box : null;
}
