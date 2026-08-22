import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../test/setup";
import candles from "../lib/indexer/fixtures/candles.json";
import Trade from "./Trade";

const ADDRESS = "0x1111111111111111111111111111111111111111";

// PriceChart wraps `lightweight-charts`, which has no jsdom canvas — mock it
// exactly the way PriceChart's own test does (a sentinel `CandlestickSeries`
// definition + spy-able `createChart`/`addSeries`/`setData`), so this test
// exercises the REAL `PriceChart` (proving Trade wires it up: the
// `data-testid="price-chart"` container renders and receives converted
// candles), while nothing here re-tests `PriceChart`'s own internals — that's
// already covered by `PriceChart.test.tsx`.
const h = vi.hoisted(() => ({
  createChart: vi.fn(),
  addSeries: vi.fn(),
  setData: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: { __brand: "CandlestickSeries-v5-definition" },
  createChart: h.createChart,
}));

function renderTrade() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/token/${ADDRESS}`]}>
        <Routes>
          <Route path="/token/:address" element={<Trade />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Trade", () => {
  beforeEach(() => {
    h.addSeries.mockReturnValue({ setData: h.setData });
    h.createChart.mockReturnValue({ addSeries: h.addSeries, remove: h.remove });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the info panel (name/symbol/description/socials) from fetchToken's fixture", async () => {
    renderTrade();

    expect(await screen.findByText("Pons Test Token")).toBeInTheDocument();
    expect(screen.getByText("PONS")).toBeInTheDocument();
    expect(screen.getByText(/test token fixture used to exercise/i)).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /twitter/i })).toHaveAttribute(
      "href",
      "https://twitter.com/ponstoken",
    );
    expect(screen.getByRole("link", { name: /telegram/i })).toHaveAttribute(
      "href",
      "https://t.me/ponstoken",
    );
    expect(screen.getByRole("link", { name: /discord/i })).toHaveAttribute(
      "href",
      "https://discord.gg/ponstoken",
    );
    expect(screen.getByRole("link", { name: /website/i })).toHaveAttribute(
      "href",
      "https://pons.example",
    );
    expect(screen.getByRole("link", { name: /farcaster/i })).toHaveAttribute(
      "href",
      "https://warpcast.com/ponstoken",
    );
  });

  it("renders the chart container and feeds it fetchCandles' items converted to plain numbers", async () => {
    renderTrade();

    await screen.findByText("Pons Test Token");
    expect(screen.getByTestId("price-chart")).toBeInTheDocument();

    // The chart mounts before `fetchCandles` resolves (an empty `setData([])`
    // call is expected for that first render), so assert on the LAST call
    // rather than the first.
    await waitFor(() => {
      const lastCall = h.setData.mock.calls.at(-1)?.[0] as Array<Record<string, number>> | undefined;
      expect(lastCall?.[0]).toEqual({
        time: Number(candles.items[0].bucketStart),
        open: Number(candles.items[0].open),
        high: Number(candles.items[0].high),
        low: Number(candles.items[0].low),
        close: Number(candles.items[0].close),
      });
    });
  });

  it("re-queries fetchCandles with the new interval when a timeframe button is clicked", async () => {
    const seenIntervals: (string | null)[] = [];
    server.use(
      http.get("*/tokens/:address/candles", ({ request }) => {
        seenIntervals.push(new URL(request.url).searchParams.get("interval"));
        return HttpResponse.json(candles);
      }),
    );

    renderTrade();
    await screen.findByText("Pons Test Token");
    await waitFor(() => expect(seenIntervals).toEqual(["1h"]));

    fireEvent.click(screen.getByRole("button", { name: "5m" }));

    await waitFor(() => expect(seenIntervals).toEqual(["1h", "5m"]));
  });

  it("renders a Holders / Recent trades tab pair, defaulting to Recent trades, from fixture data", async () => {
    renderTrade();
    await screen.findByText("Pons Test Token");

    // Default tab is "Recent trades": a trades-fixture trader address shows
    // (the sell row's trader, which — unlike the buy trader — appears only
    // once in the fixture), a holders-fixture address (the deployer,
    // distinct from every trader) does not.
    expect(await screen.findByText(/0x6666…6666/)).toBeInTheDocument();
    expect(screen.queryByText(/0x2222…2222/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Holders" }));

    expect(await screen.findByText(/0x2222…2222/)).toBeInTheDocument();
    expect(screen.getByText(/50(\.00)?%/)).toBeInTheDocument();
  });

  it("renders the TradePanel placeholder slot", async () => {
    renderTrade();
    await screen.findByText("Pons Test Token");
    expect(screen.getByTestId("trade-panel-placeholder")).toBeInTheDocument();
  });
});
