import { http, HttpResponse } from "msw";
import tokens from "../fixtures/tokens.json";
import tokenDetail from "../fixtures/token-detail.json";
import candles from "../fixtures/candles.json";
import trades from "../fixtures/trades.json";
import holders from "../fixtures/holders.json";
import holdings from "../fixtures/holdings.json";
import launchConfigs from "../fixtures/launch-configs.json";
import search from "../fixtures/search.json";

// Route-specific handlers before the plain `/tokens/:address` catch-all —
// path-to-regexp segment counts already make these mutually exclusive, but
// ordering most-specific-first keeps the list easy to scan.
export const handlers = [
  http.get("*/tokens", () => HttpResponse.json(tokens)),
  http.get("*/search", () => HttpResponse.json(search)),
  http.get("*/tokens/:address/candles", () => HttpResponse.json(candles)),
  http.get("*/tokens/:address/trades", () => HttpResponse.json(trades)),
  http.get("*/tokens/:address/holders", () => HttpResponse.json(holders)),
  http.get("*/tokens/:address", () => HttpResponse.json(tokenDetail)),
  http.get("*/wallets/:address/holdings", () => HttpResponse.json(holdings)),
  http.get("*/launch-configs", () => HttpResponse.json(launchConfigs)),
];
