import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Candle } from "../lib/indexer/schema";

// Mock lightweight-charts entirely: jsdom has no canvas, and this test only
// cares that PriceChart wires the v5 addSeries(CandlestickSeries, ...) API
// correctly and that it feeds setData the *converted* (plain-number) data —
// not that the real chart renders pixels.
const h = vi.hoisted(() => ({
  createChart: vi.fn(),
  addSeries: vi.fn(),
  setData: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("lightweight-charts", () => ({
  // A distinct sentinel value (not a string, not `addCandlestickSeries`) —
  // proves PriceChart passes THIS exact export through to addSeries rather
  // than reimplementing / stringly-typing the v5 series-definition contract.
  CandlestickSeries: { __brand: "CandlestickSeries-v5-definition" },
  ColorType: { Solid: "solid" },
  createChart: h.createChart,
}));

import { PriceChart, toChartCandles } from "./PriceChart";
import { CandlestickSeries } from "lightweight-charts";

const candles: Candle[] = [
  {
    bucketStart: "1755792800",
    open: "1.500000000000000000",
    high: "1.900000000000000000",
    low: "1.100000000000000000",
    close: "1.750000000000000000",
    volumeToken: "800000000000000000000",
    volumeQuote: "9200",
    tradeCount: 7,
  },
  {
    bucketStart: "1755796400",
    open: "1.750000000000000000",
    high: "2.000000000000000000",
    low: "1.600000000000000000",
    close: "1.800000000000000000",
    volumeToken: "1000000000000000000000",
    volumeQuote: "12000",
    tradeCount: 12,
  },
];

describe("toChartCandles", () => {
  it("parses the wire's decimal-string OHLC + bucketStart/volumeQuote into plain numbers", () => {
    expect(toChartCandles(candles)).toEqual([
      { time: 1755792800, open: 1.5, high: 1.9, low: 1.1, close: 1.75, volume: 9200 },
      { time: 1755796400, open: 1.75, high: 2, low: 1.6, close: 1.8, volume: 12000 },
    ]);
  });

  it("returns an empty array for no candles", () => {
    expect(toChartCandles([])).toEqual([]);
  });
});

describe("PriceChart", () => {
  beforeEach(() => {
    h.addSeries.mockReturnValue({ setData: h.setData });
    h.createChart.mockReturnValue({ addSeries: h.addSeries, remove: h.remove });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders its container and initializes the chart exactly once", () => {
    const { getByTestId } = render(<PriceChart candles={candles} />);
    expect(getByTestId("price-chart")).toBeInTheDocument();
    expect(h.createChart).toHaveBeenCalledTimes(1);
  });

  it("adds a series via the v5 CandlestickSeries definition object (never addCandlestickSeries)", () => {
    render(<PriceChart candles={candles} />);
    expect(h.addSeries).toHaveBeenCalledWith(CandlestickSeries, expect.any(Object));
    // The v4 shape must not appear anywhere on the mocked chart instance.
    const chartInstance = h.createChart.mock.results[0]?.value as Record<string, unknown>;
    expect(chartInstance.addCandlestickSeries).toBeUndefined();
  });

  it("calls setData with the wire candles converted to plain-number OHLC (no volume field)", () => {
    render(<PriceChart candles={candles} />);
    expect(h.setData).toHaveBeenCalledWith([
      { time: 1755792800, open: 1.5, high: 1.9, low: 1.1, close: 1.75 },
      { time: 1755796400, open: 1.75, high: 2, low: 1.6, close: 1.8 },
    ]);
  });

  it("re-sets data (without re-initializing the chart) when candles prop changes", () => {
    const { rerender } = render(<PriceChart candles={candles} />);
    expect(h.createChart).toHaveBeenCalledTimes(1);
    expect(h.setData).toHaveBeenCalledTimes(1);

    const nextCandles: Candle[] = [
      {
        bucketStart: "1755800000",
        open: "1.800000000000000000",
        high: "2.100000000000000000",
        low: "1.750000000000000000",
        close: "2.050000000000000000",
        volumeToken: "1200000000000000000000",
        volumeQuote: "14800",
        tradeCount: 15,
      },
    ];
    rerender(<PriceChart candles={nextCandles} />);

    expect(h.createChart).toHaveBeenCalledTimes(1); // chart is not re-created
    expect(h.setData).toHaveBeenCalledTimes(2);
    expect(h.setData).toHaveBeenLastCalledWith([
      { time: 1755800000, open: 1.8, high: 2.1, low: 1.75, close: 2.05 },
    ]);
  });

  it("removes the chart on unmount", () => {
    const { unmount } = render(<PriceChart candles={candles} />);
    unmount();
    expect(h.remove).toHaveBeenCalledTimes(1);
  });
});
