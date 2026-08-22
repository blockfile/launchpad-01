import { formatEther } from "viem";

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatEth(wei: bigint): string {
  const value = Number(formatEther(wei));
  const rounded = Math.round(value * 10_000) / 10_000;
  return `${rounded} ETH`;
}

export function formatPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

export function formatAge(unixSeconds: number): string {
  const deltaSeconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h`;
  return `${Math.floor(deltaSeconds / 86_400)}d`;
}
