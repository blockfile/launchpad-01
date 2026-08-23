import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";

/**
 * Dev-only mock API. Starts an MSW browser worker that answers the indexer
 * routes from local fixtures so `npm run dev` shows populated Explore/Trade
 * views with no backend running. Default ON in dev; set `VITE_ENABLE_MOCKS=0`
 * to hit a real indexer instead. The `import.meta.env.DEV` guard short-circuits
 * in production, so the dynamic import (and all of msw/browser) is dropped from
 * the production bundle and this never affects prod or the vitest node setup.
 */
async function enableMocking(): Promise<void> {
  if (!(import.meta.env.DEV && import.meta.env.VITE_ENABLE_MOCKS !== "0")) return;
  const { worker } = await import("./lib/indexer/msw/browser");
  await worker.start({
    onUnhandledRequest: "bypass",
    quiet: true,
  });
}

enableMocking().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
