import { AnimatePresence } from "framer-motion";
import { Route, Routes, useLocation } from "react-router";
import { Sidebar } from "./Sidebar";
import { Ticker } from "./Ticker";
import { PageTransition } from "./PageTransition";
import { ErrorBoundary } from "../ErrorBoundary";
import { Toaster } from "../ui/Toaster";
import { WrongNetworkBanner } from "../WrongNetworkBanner";
import Explore from "../../routes/Explore";
import Launch from "../../routes/Launch";
import Trade from "../../routes/Trade";
import Portfolio from "../../routes/Portfolio";

/**
 * The redesigned app frame: a collapsible left sidebar (brand + nav + socials +
 * wallet connect) alongside a content column whose top is a live activity
 * ticker and whose body renders the routed pages. Page internals are NOT
 * restyled here — the shell only wraps them, keeping the existing routes,
 * `ErrorBoundary`, wrong-network banner, and `Toaster` mounted.
 *
 * Route changes cross-fade via `AnimatePresence` keyed on `location.pathname`;
 * a faint radial glow sits behind the top of the content for the hero accent.
 */
export function AppShell() {
  const location = useLocation();

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <Ticker />

        <main className="scroll-slim relative flex-1 overflow-x-hidden">
          <div className="hero-glow" />
          <div className="relative z-10">
            <div className="px-4 pt-4 sm:px-6">
              <WrongNetworkBanner />
            </div>

            <ErrorBoundary>
              <AnimatePresence mode="wait" initial={false}>
                <PageTransition key={location.pathname}>
                  <Routes location={location}>
                    <Route path="/" element={<Explore />} />
                    <Route path="/create" element={<Launch />} />
                    <Route path="/token/:address" element={<Trade />} />
                    <Route path="/portfolio" element={<Portfolio />} />
                  </Routes>
                </PageTransition>
              </AnimatePresence>
            </ErrorBoundary>
          </div>
        </main>
      </div>

      <Toaster />
    </div>
  );
}
