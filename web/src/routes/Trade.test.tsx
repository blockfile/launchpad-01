import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../test/setup";
import candles from "../lib/indexer/fixtures/candles.json";
import tokenDetail from "../lib/indexer/fixtures/token-detail.json";
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

// TradePanel owns a whole quote/pool-resolution flow (live `slot0`/`balanceOf`
// chain reads) with its own test; here it's a plain stub that echoes the
// address it was handed, so this page test can prove Trade wires it to the
// route token without pulling a WagmiProvider + real contract reads into scope.
vi.mock("../components/TradePanel", () => ({
  TradePanel: ({ tokenAddress }: { tokenAddress?: string }) => (
    <div data-testid="trade-panel">panel:{tokenAddress}</div>
  ),
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

  it("mounts the TradePanel wired to the route token address", async () => {
    renderTrade();
    await screen.findByText("Pons Test Token");
    expect(screen.getByTestId("trade-panel")).toHaveTextContent(`panel:${ADDRESS}`);
  });

  it("loads a second page of trades via Load more when nextCursor is non-null", async () => {
    const trade = (txHash: string, traderAddress: string) => ({
      txHash,
      logIndex: 0,
      blockTimestamp: "1755800000",
      side: "buy" as const,
      traderAddress,
      tokenAmountRaw: "1",
      quoteAmountRaw: "1",
      price: "0.000100000000000000",
    });
    const page1 = {
      items: [trade("0xaa01", "0x5555555555555555555555555555555555555555")],
      nextCursor: "trades-2",
    };
    const page2 = {
      items: [trade("0xbb02", "0x7777777777777777777777777777777777777777")],
      nextCursor: null,
    };
    server.use(
      http.get("*/tokens/:address/trades", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        return HttpResponse.json(cursor === "trades-2" ? page2 : page1);
      }),
    );

    renderTrade();
    await screen.findByText("Pons Test Token");
    expect(await screen.findByText(/0x5555…5555/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText(/0x7777…7777/)).toBeInTheDocument();
    expect(screen.getByText(/0x5555…5555/)).toBeInTheDocument();
  });

  it("loads a second page of holders via Load more when nextCursor is non-null", async () => {
    const page1 = {
      items: [{ address: "0x2222222222222222222222222222222222222222", balance: "1", pct: 50 }],
      nextCursor: "holders-2",
      totalHolders: 2,
    };
    const page2 = {
      items: [{ address: "0x8888888888888888888888888888888888888888", balance: "1", pct: 25 }],
      nextCursor: null,
      totalHolders: 2,
    };
    server.use(
      http.get("*/tokens/:address/holders", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        return HttpResponse.json(cursor === "holders-2" ? page2 : page1);
      }),
    );

    renderTrade();
    await screen.findByText("Pons Test Token");
    fireEvent.click(screen.getByRole("button", { name: "Holders" }));
    expect(await screen.findByText(/0x2222…2222/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText(/0x8888…8888/)).toBeInTheDocument();
    expect(screen.getByText(/0x2222…2222/)).toBeInTheDocument();
  });

  it("drops a javascript: social anchor and neutralizes a javascript: logo src", async () => {
    const hostile = {
      ...tokenDetail,
      logo: "javascript:alert(1)",
      socials: { ...tokenDetail.socials, twitter: "javascript:alert(1)" },
    };
    server.use(http.get("*/tokens/:address", () => HttpResponse.json(hostile)));

    const { container } = renderTrade();
    await screen.findByText("Pons Test Token");

    // The javascript: twitter link is dropped entirely...
    expect(screen.queryByRole("link", { name: /twitter/i })).not.toBeInTheDocument();
    // ...while a legitimate https social still renders as a link.
    expect(screen.getByRole("link", { name: /telegram/i })).toBeInTheDocument();
    // The javascript: logo never reaches the DOM as an src.
    const logo = container.querySelector("img");
    expect(logo?.getAttribute("src") ?? "").not.toContain("javascript:");
  });
});
