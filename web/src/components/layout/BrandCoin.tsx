import { lazy, Suspense } from "react";
import { supportsWebGL } from "../../lib/webgl";

const Coin3D = lazy(() => import("../three/Coin3D"));

/** Static SVG coin — the always-safe fallback shown while the 3D chunk loads,
 * and the permanent mark wherever WebGL is unavailable (tests, blocklisted
 * GPUs). Gold disc + lime "R" to echo the accent palette. */
function StaticCoin() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="h-full w-full">
      <defs>
        <linearGradient id="rl-coin" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="55%" stopColor="#f5c518" />
          <stop offset="100%" stopColor="#b8860b" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="21" fill="url(#rl-coin)" stroke="#fff4cc" strokeWidth="1.5" />
      <circle cx="24" cy="24" r="15" fill="none" stroke="#0a0a0b" strokeOpacity="0.28" strokeWidth="1.4" />
      <text
        x="24"
        y="31"
        textAnchor="middle"
        fontFamily="Inter, sans-serif"
        fontSize="20"
        fontWeight="800"
        fill="#0a0a0b"
      >
        R
      </text>
    </svg>
  );
}

/**
 * The RobinLaunch coin mark. Renders the lightweight r3f coin when WebGL is
 * available (lazy-loaded so it never blocks first paint, with the static coin
 * as its Suspense fallback), and the static SVG coin otherwise. Decorative:
 * `aria-hidden` — the adjacent wordmark carries the accessible name.
 */
export function BrandCoin({ size = 40 }: { size?: number }) {
  const webgl = supportsWebGL();
  return (
    <span
      aria-hidden="true"
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {webgl ? (
        <Suspense fallback={<StaticCoin />}>
          <Coin3D />
        </Suspense>
      ) : (
        <StaticCoin />
      )}
    </span>
  );
}
