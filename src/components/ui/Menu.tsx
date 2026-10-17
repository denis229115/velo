import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { trapTabKey } from "./focusTrap";

export interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  onSelect: () => void;
}

interface MenuProps {
  open: boolean;
  onClose: () => void;
  label: string;
  items: MenuItem[];
  anchorRef?: RefObject<HTMLElement | null>;
}

/** An anchored menu. Arrow keys move, Enter chooses, Escape closes. */
export function Menu({ open, onClose, label, items, anchorRef }: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const [active, setActive] = useState(0);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActive(0);
    const id = window.setTimeout(() => menuRef.current?.focus(), 0);
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
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => Math.min(i + 1, items.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        items[active]?.onSelect();
        onClose();
      } else if (menuRef.current) {
        trapTabKey(event, menuRef.current);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, items, active]);

  if (!open) return null;
  const anchor = anchorRef?.current?.getBoundingClientRect();
  const style = anchor
    ? { position: "fixed" as const, top: anchor.bottom + 6, left: Math.max(8, anchor.left), zIndex: 80, minWidth: 180 }
    : { position: "fixed" as const, top: "20%", left: "50%", transform: "translateX(-50%)", zIndex: 80, minWidth: 180 };

  return createPortal(
    <div className="fixed inset-0 z-[80]" onMouseDown={onClose}>
      <div
        ref={menuRef}
        role="menu"
        aria-labelledby={labelId}
        tabIndex={-1}
        className="material-pop rounded-[var(--radius-menu)] py-1 outline-none"
        style={style}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div id={labelId} className="sr-only">
          {label}
        </div>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`w-full text-left px-3 py-1.5 text-row rounded-[var(--radius-menu-item)] ${
              index === active ? "bg-state-hover" : ""
            }`}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            <span className="text-text-primary">{item.label}</span>
            {item.detail && <span className="block text-meta text-text-tertiary">{item.detail}</span>}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
