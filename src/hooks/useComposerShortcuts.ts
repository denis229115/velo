import { useEffect, useRef, type RefObject } from "react";
import { useShortcutStore } from "@/stores/shortcutStore";
import { hasCommandModifier, matchesKey } from "@/utils/shortcutKeys";
import { takeComposerEnter } from "@/components/ai/composerEnter";

interface ComposerShortcutHandlers {
  onSend?: () => void;
  onSendLater?: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    target.closest("[contenteditable='true']") !== null
  );
}

/**
 * Dispatch the registry's send-now and send-later shortcuts to a composer.
 * Bindings are read at keypress time, so rebinding takes effect immediately.
 * Listens in the capture phase so the keys reach the composer before the
 * editor (e.g. TipTap's Mod-Enter hard break) or the global shortcut handler.
 */
export function useComposerShortcuts(handlers: ComposerShortcutHandlers, enabled: boolean, owner: RefObject<HTMLElement | null>): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const root = owner.current;
      const target = e.target instanceof HTMLElement ? e.target : document.activeElement;
      if (!root || !(target instanceof HTMLElement) || !root.contains(target)) return;
      // A nested dialog owns its keys even when rendered inside the composer.
      const dialog = target.closest('[role="dialog"], dialog');
      if (dialog && !dialog.contains(root)) return;
      const keyMap = useShortcutStore.getState().keyMap;
      const actions: [string | undefined, (() => void) | undefined][] = [
        [keyMap["app.send"], handlersRef.current.onSend],
        [keyMap["app.sendLater"], handlersRef.current.onSendLater],
      ];
      for (const [binding, handler] of actions) {
        if (!binding || !handler || !matchesKey(binding, e)) continue;
        // A plain-key binding must not fire while the operator is typing
        if (!hasCommandModifier(binding) && isTypingTarget(e.target)) continue;
        e.preventDefault();
        e.stopPropagation();
        if (binding === keyMap["app.send"] && takeComposerEnter()) return;
        handler();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, owner]);
}
