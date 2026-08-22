import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  danger?: boolean;
  title: string;
  question?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}

/**
 * A confirmation dialog for anything irreversible, replacing window.confirm.
 *
 * A browser-native dialog can't be styled (nothing marks an action "live" vs
 * "dry run"), collapses a summary to unformatted prose, and is dismissed by
 * reflex. This component makes three deliberate refusals instead:
 *
 *   Enter never confirms. Focus lands on the dialog panel itself (not a
 *   button) when it opens, so a keystroke already in flight hits nothing, and
 *   Enter is swallowed everywhere except on a button the operator has
 *   deliberately focused.
 *
 *   Escape and a backdrop click always cancel. The reflexive gestures all
 *   resolve to "no" — only a deliberate click on the confirm button is "yes".
 *
 *   `danger` is not decoration — it marks an action that cannot be undone.
 */
export function Modal({
  open,
  danger = false,
  title,
  question = "Proceed?",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);
  // Kept in a ref so the Escape listener below never goes stale against a
  // re-rendered handler while the dialog is open.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    if (!open) return undefined;

    restore.current = document.activeElement;
    // Focus the panel, not a control: see the note about Enter above. The
    // exception is a dialog that asks the operator to type something, which
    // marks its own field with data-autofocus.
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]");
    (first ?? panel.current)?.focus();

    // The page behind must not scroll away under the dialog.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // The single source of truth for Escape-to-cancel: attached on window so
    // it still works even if focus ever ends up somewhere unexpected, and
    // it's the only Escape listener in this component so a keystroke can
    // never fire onCancel more than once.
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") cancel.current?.();
    };
    window.addEventListener("keydown", onEscape);

    return () => {
      window.removeEventListener("keydown", onEscape);
      document.body.style.overflow = previousOverflow;
      // Put the caret back where it was, so cancelling costs the operator
      // nothing but the click. preventScroll because focus() otherwise
      // scrolls its target into view.
      if (restore.current instanceof HTMLElement) {
        restore.current.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      // Only a button the operator has deliberately moved to may act on
      // Enter; everything else swallows the keystroke.
      if (!(e.target instanceof HTMLButtonElement)) e.preventDefault();
      return;
    }

    if (e.key !== "Tab") return;

    // Hold focus inside the dialog. Tabbing out and hitting Enter on
    // whatever was behind is exactly the accident this component prevents.
    const items = Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]"
      ) ?? []
    );
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const here = document.activeElement;
    if (e.shiftKey && (here === firstItem || here === panel.current)) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && here === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      // mousedown rather than click: a click fires on the common ancestor,
      // so a text selection dragged out of the dialog would otherwise
      // dismiss it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className={`modal ${danger ? "is-danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        ref={panel}
      >
        <h2 className="modal-title" id="modal-title">
          {title}
        </h2>

        <div className="modal-body">{children}</div>

        {question && <p className="modal-question">{question}</p>}

        <div className="modal-foot">
          {/* Cancel first in tab order and reading order: the way out
              should be the thing found first. */}
          <button type="button" className="quiet" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "danger" : ""}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * One labelled figure inside a dialog — the token, the amount, the count.
 * Laid out in a column with the tabular-numeral treatment other figures in
 * this kit get, rather than run together into a sentence.
 */
export function Fact({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="modal-fact">
      <span>{label}</span>
      <b className={mono ? "addr" : ""}>{children}</b>
    </div>
  );
}
