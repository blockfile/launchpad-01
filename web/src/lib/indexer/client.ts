import type { z } from "zod";
import {
  candlesResponseSchema,
  holdersPageSchema,
  holdingsSchema,
  launchConfigsSchema,
  searchResultsSchema,
  statsSchema,
  tokenDetailSchema,
  tokensPageSchema,
  tradesPageSchema,
} from "./schema";

const BASE_URL = import.meta.env.VITE_INDEXER_URL ?? "/indexer";

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`indexer ${path} → ${res.status}`);
  const json = await res.json();
  return schema.parse(json);
}

export function fetchTokens(params: { sort?: string; cursor?: string } = {}) {
  const search = new URLSearchParams();
  if (params.sort) search.set("sort", params.sort);
  if (params.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  return get(`/tokens${qs ? `?${qs}` : ""}`, tokensPageSchema);
}
export function fetchToken(address: string) {
  return get(`/tokens/${address}`, tokenDetailSchema);
}
export function fetchCandles(address: string, interval: "1m" | "5m" | "1h" | "1d") {
  return get(`/tokens/${address}/candles?interval=${interval}`, candlesResponseSchema);
}
export function fetchTrades(address: string, cursor?: string) {
  return get(`/tokens/${address}/trades${cursor ? `?cursor=${cursor}` : ""}`, tradesPageSchema);
}
export function fetchHolders(address: string, cursor?: string) {
  return get(
    `/tokens/${address}/holders${cursor ? `?cursor=${cursor}` : ""}`,
    holdersPageSchema,
  );
}
export function search(q: string) {
  return get(`/search?q=${encodeURIComponent(q)}`, searchResultsSchema);
}
export function fetchStats() {
  return get("/stats", statsSchema);
}
export function fetchLaunchConfigs() {
  return get("/launch-configs", launchConfigsSchema);
}
export function fetchHoldings(wallet: string, cursor?: string) {
  return get(`/wallets/${wallet}/holdings${cursor ? `?cursor=${cursor}` : ""}`, holdingsSchema);
}
