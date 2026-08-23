import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartCandle } from "../lib/indexer/schema";

/**
 * The chart boundary: B's candles wire format is decimal strings
 * (uint256-safe, matching every other amount in its API — see the indexer
 * spec's "Wire-format contract" note and Task 5's schema). `lightweight-charts`
 * needs plain numbers, so that parse happens here, once, and nowhere else —
 * never by asking B to change its wire type.
 */
export function toChartCandles(candles: Candle[]): ChartCandle[] {
  return candles.map((c) => ({
    time: Number(c.bucketStart),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volumeQuote),
  }));
}

export interface PriceChartProps {
  candles: Candle[];
}

export function PriceChart({ candles }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  // Chart init runs once per mount; teardown on unmount only.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height: 400,
      autoSize: true,
      // Dark theme to match the terminal surface (lightweight-charts ships a
      // light default). Transparent background lets the card surface show.
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b909a",
        fontFamily:
          "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)" },
      crosshair: {
        horzLine: { color: "#4b5563", labelBackgroundColor: "#14161a" },
        vertLine: { color: "#4b5563", labelBackgroundColor: "#14161a" },
      },
    });
    // v5 API: series are added via `addSeries(<SeriesDefinition>, options)`,
    // never the v4 `chart.addCandlestickSeries({...})` (removed in v5).
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#f43f5e",
      wickUpColor: "#34d399",
      wickDownColor: "#f43f5e",
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Data updates are imperative `setData` calls on the existing series —
  // the chart itself is not recreated when `candles` changes.
  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(
      toChartCandles(candles).map(({ time, open, high, low, close }) => ({
        time: time as UTCTimestamp,
        open,
        high,
        low,
        close,
      }))
    );
  }, [candles]);

  return <div ref={containerRef} data-testid="price-chart" />;
}
