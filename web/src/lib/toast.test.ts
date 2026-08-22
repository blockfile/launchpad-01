import { describe, expect, it, vi } from "vitest";
import { notify } from "./toast";

describe("notify", () => {
  it("dispatches a launchpad:notice CustomEvent", () => {
    const handler = vi.fn();
    window.addEventListener("launchpad:notice", handler);
    notify("done", "ok");
    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ message: "done", kind: "ok" });
    window.removeEventListener("launchpad:notice", handler);
  });
});
