export type ToastKind = "error" | "ok" | "info";

export function notify(message: string, kind: ToastKind = "info") {
  if (typeof window === "undefined" || !message) return;
  window.dispatchEvent(new CustomEvent("launchpad:notice", { detail: { message, kind } }));
}
