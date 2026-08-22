import { useEffect, useState } from "react";
import type { ToastKind } from "../../lib/toast";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

const TTL_MS: Record<ToastKind, number> = {
  error: 8000,
  ok: 4500,
  info: 4500,
};

let seq = 0;

/**
 * The notice rail — instrument tickets that slide in when an action is
 * refused or completed, so nothing fails silently into a panel elsewhere on
 * the page.
 *
 * Listens for the one `launchpad:notice` event any module can raise (see
 * `lib/toast.ts`'s `notify`) and auto-clears each toast after a few seconds.
 * Errors linger longer than confirmations, because a refusal is a thing to
 * read and act on. Presentation only: it invents no behaviour, it just shows
 * what already happened where the operator is looking.
 */
export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    function onNotice(e: Event) {
      const detail = (e as CustomEvent<{ message?: string; kind?: ToastKind }>).detail;
      const message = detail?.message;
      if (!message) return;
      const kind = detail?.kind ?? "info";
      const id = ++seq;
      setToasts((current) => [...current.slice(-3), { id, message, kind }]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, TTL_MS[kind]);
    }

    window.addEventListener("launchpad:notice", onNotice);
    return () => window.removeEventListener("launchpad:notice", onNotice);
  }, []);

  function dismiss(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-msg">{toast.message.replace(/^ERROR:\s*/i, "")}</span>
          <button
            type="button"
            className="toast-x"
            aria-label="dismiss"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
