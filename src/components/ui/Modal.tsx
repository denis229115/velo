import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { CSSTransition } from "react-transition-group";
import { focusableIn, trapTabKey } from "./focusTrap";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  /** Custom z-index class (default: "z-50") */
  zIndex?: string;
  /** Additional classes on the panel container */
  panelClassName?: string;
  /** Replace the default header entirely */
  renderHeader?: ReactNode;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  width = "w-72",
  zIndex = "z-50",
  panelClassName,
  renderHeader,
}: ModalProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = focusableIn(panel)[0];
      (first ?? panel).focus();
    }, 0);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const panel = panelRef.current;
      if (panel) trapTabKey(e, panel);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [isOpen, onClose]);

  return createPortal(
    <CSSTransition in={isOpen} timeout={150} classNames="modal" unmountOnExit nodeRef={nodeRef}>
      <div data-modal-root ref={nodeRef} className={`fixed inset-0 ${zIndex} flex items-center justify-center`} onContextMenu={(e) => e.stopPropagation()}>
        <div className="absolute inset-0 bg-black/20" onClick={onClose} />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={renderHeader === undefined ? titleId : undefined}
          aria-label={renderHeader !== undefined ? title : undefined}
          tabIndex={-1}
          className={`relative bg-surface-overlay border border-separator rounded-[var(--radius-modal)] overlay-shadow outline-none ${width}${panelClassName ? ` ${panelClassName}` : ""}`}
        >
          {renderHeader !== undefined ? (
            renderHeader
          ) : (
            <div className="px-4 py-3 border-b border-border-primary flex items-center justify-between">
              <h3 id={titleId} className="text-sm font-semibold text-text-primary">{title}</h3>
              <button
                onClick={onClose}
                className="text-text-tertiary hover:text-text-primary text-lg leading-none"
              >
                ×
              </button>
            </div>
          )}
          {children}
        </div>
      </div>
    </CSSTransition>,
    document.body,
  );
}
