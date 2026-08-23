import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App, { ErrorBoundary } from "./App";

describe("App", () => {
  it("renders the app shell", () => {
    render(<App />);
    // The sidebar wordmark is the app's discoverable top-level heading.
    expect(screen.getByRole("heading", { name: /robinlaunch/i })).toBeInTheDocument();
  });
});

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function Boom(): never {
    throw new Error("kaboom-from-child");
  }

  it("renders a friendly, recoverable fallback (not a blank screen) when a child throws during render", () => {
    // React logs the caught error to console.error; silence it so the run stays
    // clean while still asserting the boundary rendered its fallback.
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    // The fallback rendered — the tree was NOT left blank.
    expect(screen.getByTestId("app-error-boundary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
    // The underlying error message is surfaced for the user...
    expect(screen.getByText(/kaboom-from-child/)).toBeInTheDocument();
    // ...alongside recovery affordances.
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go home/i })).toBeInTheDocument();
  });

  it("renders its children unchanged when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(screen.queryByTestId("app-error-boundary")).not.toBeInTheDocument();
  });
});
