import { useEffect, useRef } from "react";

export interface ShortcutActionDetail {
  actionId: string;
  ticketId?: string;
  threadId?: string;
  accountId?: string;
}

/** Adapt registry actions to the same handlers used by the visible controls. */
export function useShortcutAction(actionId: string, handler: (detail: ShortcutActionDetail) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<ShortcutActionDetail>).detail;
      if (detail.actionId === actionId) handlerRef.current(detail);
    };
    window.addEventListener("velo-shortcut-action", handle);
    return () => window.removeEventListener("velo-shortcut-action", handle);
  }, [actionId]);
}

export function dispatchShortcutAction(detail: ShortcutActionDetail) {
  window.dispatchEvent(new CustomEvent("velo-shortcut-action", { detail }));
}
