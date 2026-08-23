import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from "react";
import { useNavigate } from "react-router";
import { motion } from "framer-motion";
import { FaXTwitter, FaTelegram, FaGlobe } from "react-icons/fa6";
import { LuUsers, LuClock, LuArrowUpRight, LuArrowDownRight } from "react-icons/lu";
import type { IconType } from "react-icons";
import type { TokenListItem } from "../lib/indexer/schema";
import { formatAge, formatPct } from "../lib/format";
import { safeImageSrc, safeLinkHref, PLACEHOLDER_IMAGE } from "../lib/safeUrl";
import { MotionCard, cardVariants } from "./ui/MotionCard";

/** Swap a logo that 404s / fails to decode for the neutral inline placeholder
 * (a dead or hostile `<img src>` shouldn't leak broken-image chrome). Guarded
 * by a dataset flag so a placeholder that itself failed can't loop. */
export function onLogoError(event: SyntheticEvent<HTMLImageElement>) {
  const img = event.currentTarget;
  if (img.dataset.fallback) return;
  img.dataset.fallback = "1";
  img.src = PLACEHOLDER_IMAGE;
}

/**
 * A token's optional social links. Never present on B's `/tokens` list payload
 * (only `/tokens/:address` carries `socials`), so on the Explore board these
 * are always absent and the social row renders empty — but the prop keeps this
 * card reusable anywhere the detail-level socials ARE known (a token page, a
 * richer Portfolio row). Every value is funnelled through `safeLinkHref` before
 * it can reach an `<a href>`.
 */
export interface CardSocials {
  twitter?: string | null;
  telegram?: string | null;
  website?: string | null;
}

/** `price`/`marketCap`/`volume24h` arrive as already-human-decimal strings from
 * B (its `formatPrice18` did the wei→decimal conversion server-side) — this is
 * only a thousands-separator pass, never a wei conversion (`formatEth`). A null
 * value (pre-first-trade) has no number to show, so callers render a "new"
 * state instead of the returned dash. */
export function formatTokenAmount(value: string | null): string {
  if (value == null) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Compact market-cap read for the dense board ("123.45K", "4.2M"). Returns
 * null for an untraded token (null marketCap) so the caller can swap in a
 * tasteful "New" badge rather than printing "NaN"/"—". */
export function formatCompactAmount(value: string | null): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });
}

const SOCIAL_ICONS: { key: keyof CardSocials; Icon: IconType; label: string }[] = [
  { key: "twitter", Icon: FaXTwitter, label: "Twitter" },
  { key: "telegram", Icon: FaTelegram, label: "Telegram" },
  { key: "website", Icon: FaGlobe, label: "Website" },
];

/** 24h change pill: emerald + up-arrow when ≥0, rose + down-arrow when <0, and
 * a neutral "New" chip when B reports no 24h stat yet (null bps). */
function ChangeChip({ bps }: { bps: number | null }) {
  if (bps == null) {
    return (
      <span className="chip border-border !bg-surface-2 text-[0.72rem] text-ink-muted">New</span>
    );
  }
  const up = bps >= 0;
  return (
    <span
      className={`chip !gap-1 border-transparent text-[0.72rem] font-semibold tnum ${
        up ? "!bg-emerald/12 text-emerald" : "!bg-rose/12 text-rose"
      }`}
    >
      {up ? <LuArrowUpRight className="text-sm" /> : <LuArrowDownRight className="text-sm" />}
      {formatPct(bps / 100)}
    </span>
  );
}

/** Sanitized social row — renders only the links that survive `safeLinkHref`
 * (https/ipfs); a rejected or missing link contributes no anchor at all. Each
 * anchor stops click propagation so it never triggers the card's navigation. */
function SocialRow({ socials }: { socials?: CardSocials }) {
  if (!socials) return null;
  const links = SOCIAL_ICONS.map(({ key, Icon, label }) => ({
    href: safeLinkHref(socials[key]),
    Icon,
    label,
  })).filter((l): l is { href: string; Icon: IconType; label: string } => l.href !== null);
  if (links.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {links.map(({ href, Icon, label }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          onClick={(event) => event.stopPropagation()}
          className="rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon className="text-sm" />
        </a>
      ))}
    </div>
  );
}

interface TokenCardProps {
  item: TokenListItem;
  socials?: CardSocials;
  variant?: "grid" | "list";
}

/**
 * The shared token tile the Explore board is built from — a `MotionCard` (grid)
 * or a dense row (list) that navigates to `/token/:address` on click/Enter.
 * Navigation is imperative (`role="link"` + `useNavigate`), matching the app's
 * "no anchor wrapping block content" rule, which also lets the inner social
 * `<a>`s remain valid nested links. Purely presentational: every URL is
 * sanitized, every number is display-formatted, and an untraded token shows a
 * "New" state instead of "NaN". Reusable beyond Explore (e.g. Portfolio).
 */
export function TokenCard({ item, socials, variant = "grid" }: TokenCardProps) {
  const navigate = useNavigate();
  const go = () => navigate(`/token/${item.address}`);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      go();
    }
  };

  const marketCap = formatCompactAmount(item.marketCap);
  const price = item.price == null ? null : formatTokenAmount(item.price);
  const age = formatAge(Number(item.launchTimestamp));
  const label = `${item.name} (${item.symbol})`;

  if (variant === "list") {
    return (
      <motion.div
        variants={cardVariants}
        role="link"
        tabIndex={0}
        aria-label={label}
        onClick={go}
        onKeyDown={onKeyDown}
        whileHover={{ x: 2 }}
        className="surface-card surface-card-hover flex cursor-pointer items-center gap-4 px-4 py-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <img
            src={safeImageSrc(item.logo)}
            alt=""
            onError={onLogoError}
            className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-border"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink">{item.name}</div>
            <div className="truncate font-mono text-[11px] uppercase text-ink-muted">
              {item.symbol}
            </div>
          </div>
        </div>
        <div className="w-24 shrink-0 text-right">
          {marketCap == null ? (
            <span className="text-xs text-ink-faint">New</span>
          ) : (
            <span className="tnum text-sm font-semibold text-ink">{marketCap}</span>
          )}
        </div>
        <div className="hidden w-24 shrink-0 text-right tnum text-sm text-ink-muted sm:block">
          {price ?? "—"}
        </div>
        <div className="hidden w-24 shrink-0 justify-end sm:flex">
          <ChangeChip bps={item.priceChangeBps24h} />
        </div>
        <div className="hidden w-16 shrink-0 items-center justify-end gap-1 text-xs text-ink-muted md:flex">
          <LuUsers className="text-sm" /> {item.holderCount}
        </div>
        <div className="hidden w-12 shrink-0 items-center justify-end gap-1 text-xs text-ink-muted md:flex">
          <LuClock className="text-sm" /> {age}
        </div>
      </motion.div>
    );
  }

  return (
    <MotionCard
      role="link"
      tabIndex={0}
      aria-label={label}
      onClick={go}
      onKeyDown={onKeyDown}
      className="group flex cursor-pointer flex-col gap-3 p-4"
    >
      <div className="flex items-start gap-3">
        <img
          src={safeImageSrc(item.logo)}
          alt=""
          onError={onLogoError}
          className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-border transition-transform duration-200 group-hover:scale-105"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold leading-tight text-ink">{item.name}</div>
          <div className="truncate font-mono text-[11px] uppercase tracking-wide text-ink-muted">
            {item.symbol}
          </div>
        </div>
        <span className="chip border-accent/25 !bg-accent/10 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wider text-accent">
          V3
        </span>
      </div>

      <div>
        <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">Market cap</div>
        {marketCap == null ? (
          <span className="chip mt-1 border-accent/25 !bg-accent/10 text-[0.72rem] font-semibold text-accent">
            New · not yet traded
          </span>
        ) : (
          <div className="tnum text-xl font-semibold text-ink">{marketCap}</div>
        )}
      </div>

      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">Price</div>
          <div className="truncate tnum text-sm text-ink-muted">{price ?? "—"}</div>
        </div>
        <ChangeChip bps={item.priceChangeBps24h} />
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-3 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <LuUsers className="text-sm" /> {item.holderCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <LuClock className="text-sm" /> {age}
          </span>
        </div>
        <SocialRow socials={socials} />
      </div>
    </MotionCard>
  );
}
