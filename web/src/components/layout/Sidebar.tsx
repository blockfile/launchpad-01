import { useState } from "react";
import { NavLink } from "react-router";
import { motion } from "framer-motion";
import { LuCompass, LuRocket, LuWallet, LuPanelLeftClose, LuPanelLeftOpen } from "react-icons/lu";
import { FaXTwitter, FaTelegram, FaDiscord, FaGithub } from "react-icons/fa6";
import type { IconType } from "react-icons";
import { ConnectButton } from "../ConnectButton";
import { BrandCoin } from "./BrandCoin";

interface NavItem {
  to: string;
  label: string;
  icon: IconType;
  end?: boolean;
}

// Mirrors the app's real top-level routes. `/token/:address` is intentionally
// absent — it's a dynamic detail route, never a fixed nav destination.
const NAV: NavItem[] = [
  { to: "/", label: "Explore", icon: LuCompass, end: true },
  { to: "/create", label: "Launch", icon: LuRocket },
  { to: "/portfolio", label: "Portfolio", icon: LuWallet },
];

const SOCIALS: { label: string; icon: IconType }[] = [
  { label: "X (Twitter)", icon: FaXTwitter },
  { label: "Telegram", icon: FaTelegram },
  { label: "Discord", icon: FaDiscord },
  { label: "GitHub", icon: FaGithub },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 76 : 240 }}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="sticky top-0 z-20 flex h-screen shrink-0 flex-col border-r border-border bg-bg-2/70 backdrop-blur"
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 py-4">
        <BrandCoin size={collapsed ? 34 : 38} />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-[15px] font-extrabold tracking-tight text-ink">
              Robin<span className="text-gold">Launch</span>
            </h1>
            <div className="truncate text-[10px] uppercase tracking-widest text-ink-faint">
              memecoin terminal
            </div>
          </div>
        )}
      </div>

      {/* Primary nav */}
      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? item.label : undefined}
              className="group relative block rounded-xl"
            >
              {({ isActive }) => (
                <span className="relative flex items-center gap-3 px-3 py-2.5">
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-xl border border-border-strong bg-surface"
                      transition={{ type: "spring", stiffness: 400, damping: 34 }}
                    />
                  )}
                  <Icon
                    className={`relative z-10 shrink-0 text-lg transition-colors ${
                      isActive ? "text-accent" : "text-ink-muted group-hover:text-ink"
                    }`}
                  />
                  {!collapsed && (
                    <span
                      className={`relative z-10 text-sm font-medium transition-colors ${
                        isActive ? "text-ink" : "text-ink-muted group-hover:text-ink"
                      }`}
                    >
                      {item.label}
                    </span>
                  )}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Socials + connect + collapse */}
      <div className="flex flex-col gap-3 border-t border-border px-3 py-4">
        <div className={`flex gap-1 ${collapsed ? "flex-col items-center" : "items-center"}`}>
          {SOCIALS.map((s) => {
            const Icon = s.icon;
            return (
              <a
                key={s.label}
                href="#"
                aria-label={s.label}
                className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface hover:text-ink"
              >
                <Icon className="text-base" />
              </a>
            );
          })}
        </div>

        {!collapsed && (
          <div className="[&_button]:!w-full">
            <ConnectButton />
          </div>
        )}

        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex items-center justify-center gap-2 rounded-lg border border-border px-2 py-2 text-xs text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
        >
          {collapsed ? <LuPanelLeftOpen /> : <LuPanelLeftClose />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </motion.aside>
  );
}
