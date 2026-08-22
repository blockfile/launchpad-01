import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../test/setup";
import Explore from "./Explore";
import tokens from "../lib/indexer/fixtures/tokens.json";

/** Renders the current route's pathname so navigation can be asserted without
 * a real `/token/:address` route/page existing yet (that's a later task). */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderExplore() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Explore />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Explore", () => {
  it("renders the fixture's token rows", async () => {
    renderExplore();

    expect(await screen.findByText("Pons Test Token")).toBeInTheDocument();
    expect(screen.getByText("PONS")).toBeInTheDocument();
    expect(screen.getByText("Untraded Test Token")).toBeInTheDocument();
    expect(screen.getByText("UTT")).toBeInTheDocument();
  });

  it("re-queries fetchTokens with the new sort key when a sortable column header is clicked", async () => {
    const seenSorts: (string | null)[] = [];
    server.use(
      http.get("*/tokens", ({ request }) => {
        seenSorts.push(new URL(request.url).searchParams.get("sort"));
        return HttpResponse.json(tokens);
      }),
    );

    renderExplore();
    await screen.findByText("Pons Test Token");
    expect(seenSorts).toEqual(["newest"]);

    fireEvent.click(screen.getByRole("button", { name: /market cap/i }));

    await waitFor(() => expect(seenSorts).toEqual(["newest", "marketCap"]));
  });

  it("navigates to the token detail route when a row is clicked", async () => {
    renderExplore();

    const nameCell = await screen.findByText("Pons Test Token");
    fireEvent.click(nameCell);

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/token/0x1111111111111111111111111111111111111111",
      ),
    );
  });

  it("opens the ⌘K search box and renders results from search() (proves /search is actually intercepted by MSW)", async () => {
    renderExplore();
    await screen.findByText("Pons Test Token");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/search tokens/i);
    fireEvent.change(input, { target: { value: "pons" } });

    const searchResults = await screen.findByTestId("search-results");
    expect(within(searchResults).getByText("Pons Test Token")).toBeInTheDocument();
  });
});
