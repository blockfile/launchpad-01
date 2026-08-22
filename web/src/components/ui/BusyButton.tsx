import type { ButtonHTMLAttributes, ReactNode } from "react";

interface BusyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The panel's shared busy key; "" means nothing in the panel is busy. */
  busy: string;
  /** This button's own key. Only lights up when `busy === busyWhen`. */
  busyWhen: string;
  children: ReactNode;
}

/**
 * A button whose busy state is a named key, not a boolean.
 *
 * A panel with several irreversible actions (launch, approve, sell, ...)
 * shares one `busy` string. Each button only disables itself and swaps in a
 * spinner when `busy` equals its own `busyWhen` — so a sibling button never
 * inherits another action's spinner or gets disabled for someone else's
 * in-flight request.
 */
export function BusyButton({
  busy,
  busyWhen,
  children,
  disabled,
  className,
  ...rest
}: BusyButtonProps) {
  const isBusy = busy === busyWhen;

  return (
    <button
      type="button"
      className={`busy-button${className ? ` ${className}` : ""}`}
      disabled={disabled || isBusy}
      aria-busy={isBusy}
      {...rest}
    >
      {isBusy ? (
        <span className="busy-button-label">
          <span className="spinner" aria-hidden="true" />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
