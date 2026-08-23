import { useState } from "react";
import { BrowserRouter } from "react-router";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { wagmiConfig } from "./lib/wagmi";
import { AppShell } from "./components/layout/AppShell";

// Presentation-only: skins RainbowKit's connect button + modal to the
// RobinLaunch palette (lime accent, near-black foreground, charcoal surfaces)
// so the wallet UI matches the redesign instead of shipping the stock blue.
const rainbowTheme = darkTheme({
  accentColor: "#84cc16",
  accentColorForeground: "#0a0a0b",
  borderRadius: "large",
  fontStack: "system",
  overlayBlur: "small",
});

// Re-exported so existing imports (and the App test) keep resolving it from
// "./App" after the class moved to its own module.
export { ErrorBoundary } from "./components/ErrorBoundary";

/**
 * The whole app in one place: the full chain-aware provider stack
 * (`WagmiProvider` → `QueryClientProvider` → `RainbowKitProvider`) wraps the
 * router, and the redesigned `AppShell` (sidebar + live ticker + routed pages,
 * with the `Toaster`, `ErrorBoundary`, and wrong-network banner mounted inside)
 * renders once here. This file's only job is wiring, not page logic.
 */
export default function App() {
  // One `QueryClient` per mounted `App`, not a module-level singleton: mirrors
  // `src/test/providers.tsx`'s `renderWithProviders` harness so a fresh app
  // mount (e.g. a fresh test render) never inherits another mount's cache.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowTheme}>
          <BrowserRouter>
            <AppShell />
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
