import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { wagmiConfig } from "./lib/wagmi";
import { ConnectButton } from "./components/ConnectButton";
import { Toaster } from "./components/ui/Toaster";
import Explore from "./routes/Explore";
import Launch from "./routes/Launch";
import Trade from "./routes/Trade";
import Portfolio from "./routes/Portfolio";

// Static top-level nav entries. `/token/:address` is deliberately not one of
// these — it's a dynamic detail route only ever reached by navigating from a
// token row (Explore/Portfolio/search) or the post-launch redirect, never a
// fixed link a user would click from the header.
const NAV_LINKS = [
  { to: "/", label: "Explore", end: true },
  { to: "/create", label: "Launch" },
  { to: "/portfolio", label: "Portfolio" },
];

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? "font-semibold text-white" : "text-slate-400 hover:text-slate-100";
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-wide last line of defense against a render-time throw. React unmounts the
 * ENTIRE component tree when a render throws and nothing catches it — a blank
 * white screen (exactly what a null factory address once did to the Launch
 * page). This boundary catches any such throw and shows a friendly, recoverable
 * fallback instead, so no future render error can ever blank the whole app.
 *
 * Individual pages still handle their own expected empty/unavailable states
 * gracefully (see the "not available on this network" notices) — this only
 * catches the truly-unexpected, and must never itself throw.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="mx-auto max-w-xl p-6 text-slate-100"
        data-testid="app-error-boundary"
      >
        <h1 className="mb-2 text-2xl font-semibold">Something went wrong</h1>
        <p className="mb-4 text-slate-400">
          The app hit an unexpected error and couldn&apos;t finish rendering this page. Your funds
          and data are unaffected — reloading usually clears it.
        </p>
        <pre className="mb-4 overflow-auto rounded border border-slate-800 bg-slate-900 p-3 text-sm text-rose-300">
          {error.message}
        </pre>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded bg-emerald-600 px-4 py-2 font-semibold"
          >
            Reload
          </button>
          <a
            href="/"
            className="rounded border border-slate-700 px-4 py-2 font-semibold text-slate-200 hover:border-slate-500"
          >
            Go home
          </a>
        </div>
      </div>
    );
  }
}

/**
 * The whole app in one place: the full chain-aware provider stack
 * (`WagmiProvider` → `QueryClientProvider` → `RainbowKitProvider`, Task 3)
 * wraps the router, and the nav header (brand + route links + wallet
 * connect, Task 3) plus the `Toaster` (Task 4) mount once here rather than
 * being re-declared per route. Every route component below is a plain default
 * export (Tasks 6/9/10/13) — this file's only job is wiring, not page logic.
 */
export default function App() {
  // One `QueryClient` per mounted `App`, not a module-level singleton: mirrors
  // `src/test/providers.tsx`'s `renderWithProviders` harness so a fresh app
  // mount (e.g. a fresh test render) never inherits another mount's cache.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <BrowserRouter>
            <div className="min-h-screen bg-slate-950 text-slate-100">
              <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-6 py-4">
                <div className="flex items-center gap-6">
                  <h1 className="text-xl font-semibold">Launchpad</h1>
                  <nav className="flex gap-4 text-sm">
                    {NAV_LINKS.map((link) => (
                      <NavLink key={link.to} to={link.to} end={link.end} className={navLinkClassName}>
                        {link.label}
                      </NavLink>
                    ))}
                  </nav>
                </div>
                <ConnectButton />
              </header>

              <main>
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Explore />} />
                    <Route path="/create" element={<Launch />} />
                    <Route path="/token/:address" element={<Trade />} />
                    <Route path="/portfolio" element={<Portfolio />} />
                  </Routes>
                </ErrorBoundary>
              </main>

              <Toaster />
            </div>
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
