import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { bindConfirmHost, type ConfirmRequest } from "./confirmRequest";
import { trapTabKey } from "./focusTrap";

/** The one confirm sheet. Mount it once; `requestConfirm` opens it. */
export function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    bindConfirmHost(setRequest);
    return () => bindConfirmHost(null);
  }, []);

  return request ? <ConfirmSheet request={request} onDone={() => setRequest(null)} /> : null;
}

function ConfirmSheet({ request, onDone }: { request: ConfirmRequest; onDone: () => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const finish = (ok: boolean) => {
    request.resolve(ok);
    onDone();
  };

  useEffect(() => {
    const id = window.setTimeout(() => confirmRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
        return;
      }
      const panel = panelRef.current;
      if (panel) trapTabKey(event, panel);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [request]);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center pb-8 sm:items-center sm:pb-0">
      <div className="absolute inset-0 bg-black/20" onMouseDown={() => finish(false)} />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-surface-overlay shadow-e3 relative w-[min(24rem,calc(100%-2rem))] rounded-[var(--radius-modal)] p-4"
      >
        <h2 id={titleId} className="text-headline font-medium text-text-primary">
          {request.title}
        </h2>
        <p className="mt-1 text-row text-text-secondary">{request.message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button ref={confirmRef} variant={request.danger ? "danger" : "primary"} onClick={() => finish(true)}>
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
