import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router";
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { formatEther, parseEther, parseEventLogs } from "viem";
import { AnimatePresence, motion } from "framer-motion";
import { FaEthereum, FaTelegram, FaXTwitter } from "react-icons/fa6";
import { LuChevronDown, LuDices, LuInfo, LuLock } from "react-icons/lu";
import { launchFactoryAbi } from "@launchpad/shared";
import { resolveAddress, resolveAddressOptional } from "../lib/contracts";
import { usePredictedTokenAddress, useAvailableLaunchConfigs } from "../lib/launchConfig";
import { LogoField } from "../components/LogoField";
import { LaunchpadUnavailableNotice } from "../components/NetworkNotice";
import { WrongNetworkBanner } from "../components/WrongNetworkBanner";
import { ArmSwitch } from "../components/ui/ArmSwitch";
import { Fact, Modal } from "../components/ui/Modal";
import { formatEth, shortAddress } from "../lib/format";
import { safeImageSrc } from "../lib/safeUrl";
import { onLogoError } from "../components/TokenCard";
import { notify } from "../lib/toast";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// The exact form contract (brief Step 3). Empty strings are valid for every
// optional field so an untouched form is a well-formed launch of a token with
// no socials, no dev buy, and the connected wallet as the fee recipient.
const schema = z.object({
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(16),
  description: z.string().max(2000),
  logo: z.string().min(1, "Upload a logo first"),
  twitter: z.string(),
  telegram: z.string(),
  discord: z.string(),
  website: z.string(),
  farcaster: z.string(),
  feeWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/).or(z.literal("")),
  devBuyEth: z.string().regex(/^\d*\.?\d*$/),
});

type FormValues = z.infer<typeof schema>;

/** The on-chain `TokenParams` struct the factory's `launchToken` /
 * `predictTokenAddress` take, in ABI field order. */
interface TokenParams {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: {
    twitter: string;
    telegram: string;
    discord: string;
    website: string;
    farcaster: string;
  };
  feeWallet: `0x${string}`;
}

/** The frozen request body: everything `launchToken` will be called with,
 * snapshotted the instant "Review" is pressed and never re-derived from the
 * still-editable form afterward. `predicted` is captured alongside so the
 * post-receipt decode compares against the address the user actually saw. */
interface PendingLaunch {
  params: TokenParams;
  launchConfigId: bigint;
  dexId: bigint;
  salt: `0x${string}`;
  value: bigint;
  predicted: string | undefined;
}

/** A fresh 32-byte CREATE2 salt. One per mount is enough — `params` already
 * carries every user-visible field into the predicted-address preimage, so the
 * salt only needs to be unique per session (rerollable if a collision ever
 * surfaces), not per keystroke. */
function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

/** Dev-buy ETH string → wei. The schema already constrains this to a decimal,
 * but "" and a lone "." are both schema-valid and both un-parseable, so they
 * map to a zero dev buy. */
function devBuyToWei(value: string): bigint {
  if (!value || value === ".") return 0n;
  try {
    return parseEther(value as `${number}`);
  } catch {
    return 0n;
  }
}

/** Turns a failed-launch error (a wagmi/viem write error, or a mined-but-
 * reverted receipt) into a user-facing toast message + severity. A cancelled
 * wallet prompt is an "info"; everything else is an "error". The two
 * config-gate custom errors are named explicitly when viem decoded them — the
 * common cause is a stale, now-disabled launchConfig/dexId (see the M3
 * empty-config-picker bug that could leave a 0n id selected). */
function launchFailureToast(error: unknown): { message: string; level: "info" | "error" } {
  const text = error instanceof Error ? error.message : error ? String(error) : "";
  if (/user rejected|user denied|rejected the request|denied transaction/i.test(text)) {
    return { message: "Transaction rejected.", level: "info" };
  }
  if (/LaunchConfigDisabled/.test(text)) {
    return {
      message: "Launch reverted: that launch config is disabled. Pick another launch config and try again.",
      level: "error",
    };
  }
  if (/DexConfigDisabled/.test(text)) {
    return {
      message: "Launch reverted: that DEX is disabled. Pick another DEX and try again.",
      level: "error",
    };
  }
  return {
    message: "Launch failed — the transaction reverted or was rejected. Nothing was deployed.",
    level: "error",
  };
}

// Shared field styles — the dark, focus-lit input treatment the whole form uses.
const inputClass =
  "w-full rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-accent/50 focus:bg-surface";

/** One labelled row in the "Your token" spec list. */
function SpecRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
        {label}
        {hint && (
          <span title={hint} className="inline-flex text-ink-faint">
            <LuInfo aria-hidden className="text-[0.85em]" />
          </span>
        )}
      </span>
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">{children}</span>
    </div>
  );
}

/** A social handle input with a fixed, non-editable service prefix (x.com/,
 * t.me/). The prefix is decorative — the stored value is the raw handle, exactly
 * as before. */
function HandleField({
  label,
  prefix,
  icon,
  ...input
}: {
  label: string;
  prefix: string;
  icon: ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      <div className="flex items-center rounded-xl border border-border bg-surface-2 transition-colors focus-within:border-accent/50">
        <span className="inline-flex shrink-0 items-center gap-1 pl-3 text-sm text-ink-faint">
          {icon}
          {prefix}
        </span>
        <input
          aria-label={label}
          className="w-full min-w-0 rounded-r-xl bg-transparent py-2 pl-1 pr-3 text-sm text-ink outline-none placeholder:text-ink-faint"
          {...input}
        />
      </div>
    </label>
  );
}

export default function Launch() {
  const chainId = useChainId();
  const { address } = useAccount();
  const navigate = useNavigate();

  const { register, watch, setValue, formState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: {
      name: "",
      symbol: "",
      description: "",
      logo: "",
      twitter: "",
      telegram: "",
      discord: "",
      website: "",
      farcaster: "",
      feeWallet: "",
      devBuyEth: "",
    },
  });
  const values = watch();

  const [salt, setSalt] = useState<`0x${string}`>(() => randomSalt());
  const [uploading, setUploading] = useState(false);
  const [armed, setArmed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState<PendingLaunch | null>(null);

  const { launchConfigIds, dexIds } = useAvailableLaunchConfigs(chainId);
  const [launchConfigId, setLaunchConfigId] = useState(0n);
  const [dexId, setDexId] = useState(0n);

  // Keep the selected ids on an actually-enabled option as the lists resolve.
  useEffect(() => {
    if (launchConfigIds.length && !launchConfigIds.includes(Number(launchConfigId))) {
      setLaunchConfigId(BigInt(launchConfigIds[0]));
    }
  }, [launchConfigIds, launchConfigId]);
  useEffect(() => {
    if (dexIds.length && !dexIds.includes(Number(dexId))) {
      setDexId(BigInt(dexIds[0]));
    }
  }, [dexIds, dexId]);

  const params = useMemo<TokenParams>(
    () => ({
      name: values.name,
      symbol: values.symbol,
      logo: values.logo,
      description: values.description,
      socials: {
        twitter: values.twitter,
        telegram: values.telegram,
        discord: values.discord,
        website: values.website,
        farcaster: values.farcaster,
      },
      feeWallet: (values.feeWallet || address || ZERO_ADDRESS) as `0x${string}`,
    }),
    [
      values.name,
      values.symbol,
      values.logo,
      values.description,
      values.twitter,
      values.telegram,
      values.discord,
      values.website,
      values.farcaster,
      values.feeWallet,
      address,
    ],
  );

  // Render-path resolution: `undefined` when no factory is deployed/overridden
  // for this chain. It must NOT throw here (an uncaught render throw blanks the
  // app) — instead the page renders a friendly "not available" state below, and
  // the factory reads stay disabled until an address resolves. The WRITE path
  // (`confirmLaunch`) re-resolves with the throwing `resolveAddress` so a null
  // address hard-fails loudly before any tx is sent.
  const factory = resolveAddressOptional(chainId, "factory");
  const predictedQuery = usePredictedTokenAddress({
    chainId,
    params,
    launchConfigId,
    dexId,
    salt,
    deployer: address,
  });
  const predicted = predictedQuery.data as string | undefined;

  const launchFeeQuery = useReadContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: "launchFee",
    query: { enabled: Boolean(factory) },
  });
  const launchFee = launchFeeQuery.data as bigint | undefined;

  // Display-only native balance, for the dev-buy "Max" affordance + the
  // "X ETH available" helper. Never part of the launch value math (which stays
  // launchFee + devBuy exactly); a missing balance simply disables Max.
  const balanceQuery = useBalance({ address, query: { enabled: Boolean(address) } });
  const balanceWei = balanceQuery.data?.value as bigint | undefined;

  const devBuyWei = useMemo(() => devBuyToWei(values.devBuyEth), [values.devBuyEth]);
  const totalValue = launchFee === undefined ? undefined : launchFee + devBuyWei;

  const { writeContract, data: hash, isPending, error: writeError, reset: resetWrite } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  // The body actually submitted, held past modal-close so the post-receipt
  // decode can still compare against the predicted address the user saw. A
  // ref (not `pending`, which is cleared the instant the modal closes).
  const submitted = useRef<PendingLaunch | null>(null);

  // Navigate to the DECODED token, never the predicted address blindly: the
  // launch is only "done" once the chain has told us the real deployed
  // address. Guarded so it fires exactly once per successful receipt.
  const navigated = useRef(false);
  useEffect(() => {
    if (!receipt.isSuccess || !receipt.data || navigated.current) return;
    navigated.current = true;
    const events = parseEventLogs({
      abi: launchFactoryAbi,
      eventName: "TokenLaunched",
      logs: receipt.data.logs,
    });
    const decoded = events[0]?.args?.token as `0x${string}` | undefined;
    if (!decoded) {
      notify("Launch confirmed, but no TokenLaunched event was found in the receipt.", "error");
      return;
    }
    const expected = submitted.current?.predicted;
    if (expected && decoded.toLowerCase() !== expected.toLowerCase()) {
      notify(
        `Deployed token ${shortAddress(decoded)} differs from the predicted ${shortAddress(expected)}.`,
        "error",
      );
    }
    navigate(`/token/${decoded}`);
  }, [receipt.isSuccess, receipt.data, navigate]);

  // Surface a FAILED launch (mirrors TradePanel's revert handling). Two failure
  // shapes: (1) the write itself errored — the user rejected it, or the node
  // rejected/simulated-reverted it before broadcast (a stale
  // LaunchConfigDisabled/DexConfigDisabled lands here) — and (2) the tx mined
  // but REVERTED (viem RESOLVES the receipt with status "reverted"; it does not
  // throw, so `isSuccess` stays false and the navigate effect above never
  // fires). Either way: toast the reason and `reset()` the write state so the
  // stale `hash` no longer disables the modal's Launch button and the form can
  // be retried. Fires exactly once per failed attempt.
  const failureNotified = useRef(false);
  useEffect(() => {
    const reverted = receipt.data?.status === "reverted";
    const failed = Boolean(writeError) || receipt.isError || reverted;
    if (!failed || failureNotified.current) return;
    failureNotified.current = true;
    const { message, level } = launchFailureToast(writeError ?? receipt.error);
    notify(message, level);
    resetWrite();
  }, [writeError, receipt.isError, receipt.data, receipt.error, resetWrite]);

  const showPredicted = Boolean(values.name && values.symbol && values.logo);
  const formReady =
    Boolean(address) && formState.isValid && launchFee !== undefined && !uploading;
  const canReview = armed && formReady && !pending;
  // The CTA narrates why it can't yet act; arming only gates `disabled`, so a
  // valid-but-unarmed form still reads "Review launch" (disabled) exactly as the
  // arm-switch test expects.
  const ctaLabel = !address ? "Connect wallet" : !formReady ? "Fill token details" : "Review launch";

  function setMaxDevBuy() {
    if (balanceWei === undefined || launchFee === undefined) return;
    const spendable = balanceWei > launchFee ? balanceWei - launchFee : 0n;
    setValue("devBuyEth", formatEther(spendable), { shouldValidate: true, shouldDirty: true });
  }

  function openReview() {
    if (totalValue === undefined) return;
    // Deep-snapshot the body so nothing the form mutates afterward can leak in.
    setPending({
      params: {
        name: params.name,
        symbol: params.symbol,
        logo: params.logo,
        description: params.description,
        socials: { ...params.socials },
        feeWallet: params.feeWallet,
      },
      launchConfigId,
      dexId,
      salt,
      value: totalValue,
      predicted,
    });
  }

  function confirmLaunch() {
    if (!pending) return;
    submitted.current = pending;
    // A fresh attempt: re-arm the one-shot success/failure guards so a retry
    // after a previous failure can navigate or toast again.
    navigated.current = false;
    failureNotified.current = false;
    writeContract({
      // WRITE path: hard-fail loudly on a null address rather than send a tx to
      // `undefined`. We only get here with a resolvable factory, but re-resolve
      // through the throwing variant so this invariant is enforced at the edge.
      address: resolveAddress(chainId, "factory"),
      abi: launchFactoryAbi,
      functionName: "launchToken",
      args: [pending.params, pending.launchConfigId, pending.dexId, pending.salt],
      value: pending.value,
    });
    setPending(null);
  }

  // No factory resolvable for this chain (the default local-dev state: no
  // deploy, no VITE_FACTORY_ADDRESS). Render a calm, instructive notice INSTEAD
  // of a dead, option-less form. Placed after every hook above so hook order
  // stays stable across renders.
  if (!factory) {
    return (
      <div className="mx-auto max-w-xl px-4 py-8 sm:px-6">
        <h1 className="mb-4 text-2xl font-bold tracking-tight text-ink">Launch token</h1>
        <LaunchpadUnavailableNotice />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-5">
        <WrongNetworkBanner />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ── Left: the form ─────────────────────────────────────────────── */}
        <form className="surface-card p-5 sm:p-6" onSubmit={(e) => e.preventDefault()}>
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight text-ink">Launch token</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Deploy a token and seed its pool in one transaction. This spends real ETH.
            </p>
          </div>

          <div className="grid gap-5">
            {/* Name + Ticker */}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-sm font-medium text-ink">Name</span>
                <input aria-label="Name" placeholder="Dogwifhat" className={inputClass} {...register("name")} />
                {formState.errors.name && <span className="text-xs text-rose">Enter a token name.</span>}
              </label>
              <label className="grid gap-1.5">
                <span className="text-sm font-medium text-ink">Ticker</span>
                <input
                  aria-label="Ticker"
                  placeholder="WIF"
                  className={`${inputClass} uppercase placeholder:normal-case`}
                  {...register("symbol")}
                />
                {formState.errors.symbol && <span className="text-xs text-rose">Enter a ticker.</span>}
              </label>
            </div>

            {/* Description */}
            <label className="grid gap-1.5">
              <span className="text-sm font-medium text-ink">Description</span>
              <textarea
                aria-label="Description"
                rows={3}
                placeholder="What's the story behind your token?"
                className={`${inputClass} resize-none`}
                {...register("description")}
              />
            </label>

            {/* Token image */}
            <div className="grid gap-1.5">
              <span className="text-sm font-medium text-ink">Token image</span>
              <LogoField
                value={values.logo}
                onChange={(uri) => setValue("logo", uri, { shouldValidate: true, shouldDirty: true })}
                onUploading={setUploading}
              />
              {formState.errors.logo && (
                <span className="text-xs text-rose">{formState.errors.logo.message}</span>
              )}
            </div>

            {/* Socials: X + Telegram */}
            <div className="grid gap-4 sm:grid-cols-2">
              <HandleField
                label="X profile"
                prefix="x.com/"
                icon={<FaXTwitter aria-hidden />}
                placeholder="handle"
                {...register("twitter")}
              />
              <HandleField
                label="Telegram"
                prefix="t.me/"
                icon={<FaTelegram aria-hidden className="text-[#229ED9]" />}
                placeholder="group"
                {...register("telegram")}
              />
            </div>

            {/* Paired asset */}
            <div className="grid gap-1.5">
              <span className="text-sm font-medium text-ink">Paired asset</span>
              <div className="flex items-center justify-between rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-ink">
                <span className="inline-flex items-center gap-2 font-medium">
                  <FaEthereum aria-hidden className="text-accent" /> ETH
                </span>
                <LuChevronDown aria-hidden className="text-ink-faint" />
              </div>
              <span className="text-xs text-ink-faint">ETH is the only pairing available today.</span>
            </div>

            {/* Developer buy — a plain <div>, not a <label>: the "Max" button
                would otherwise become the label's implicit target. */}
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink">Developer buy</span>
                <button
                  type="button"
                  onClick={setMaxDevBuy}
                  className="chip border-accent/30 !bg-accent/10 !px-2.5 !py-0.5 text-xs font-semibold text-accent transition-colors hover:!bg-accent/20"
                >
                  Max
                </button>
              </div>
              <div className="flex items-center rounded-xl border border-border bg-surface-2 transition-colors focus-within:border-accent/50">
                <input
                  aria-label="Developer buy"
                  inputMode="decimal"
                  placeholder="0"
                  className="w-full min-w-0 rounded-l-xl bg-transparent px-3 py-2 text-sm text-ink outline-none tnum placeholder:text-ink-faint"
                  {...register("devBuyEth")}
                />
                <span className="inline-flex shrink-0 items-center gap-1 pr-3 text-sm text-ink-muted">
                  <FaEthereum aria-hidden className="text-ink-faint" /> ETH
                </span>
              </div>
              <span className="text-xs text-ink-faint">
                {balanceWei !== undefined ? `${formatEth(balanceWei)} available` : "Balance unavailable"} · bought
                in the launch transaction.
              </span>
            </div>

            {/* Advanced */}
            <div className="rounded-xl border border-border">
              <button
                type="button"
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-expanded={advancedOpen}
                className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium text-ink"
              >
                <span>Advanced</span>
                <motion.span
                  animate={{ rotate: advancedOpen ? 180 : 0 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="inline-flex text-ink-muted"
                >
                  <LuChevronDown aria-hidden />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {advancedOpen && (
                  <motion.div
                    key="advanced"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="grid gap-4 border-t border-border p-3">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="grid gap-1.5">
                          <span className="text-xs font-medium text-ink-muted">Launch config</span>
                          <select
                            aria-label="Launch config"
                            className={inputClass}
                            value={String(launchConfigId)}
                            onChange={(e) => setLaunchConfigId(BigInt(e.target.value))}
                          >
                            {launchConfigIds.map((id) => (
                              <option key={id} value={id}>
                                #{id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="grid gap-1.5">
                          <span className="text-xs font-medium text-ink-muted">DEX</span>
                          <select
                            aria-label="DEX"
                            className={inputClass}
                            value={String(dexId)}
                            onChange={(e) => setDexId(BigInt(e.target.value))}
                          >
                            {dexIds.map((id) => (
                              <option key={id} value={id}>
                                #{id}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-xs text-ink-muted">CREATE2 salt</div>
                          <div className="truncate font-mono text-xs text-ink">{shortAddress(salt)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSalt(randomSalt())}
                          className="btn-ghost shrink-0 !px-2.5 !py-1 text-xs"
                        >
                          <LuDices aria-hidden /> Reroll
                        </button>
                      </div>

                      <div className="grid gap-3">
                        <input aria-label="Website" placeholder="Website URL" className={inputClass} {...register("website")} />
                        <div className="grid grid-cols-2 gap-3">
                          <input aria-label="Discord" placeholder="Discord" className={inputClass} {...register("discord")} />
                          <input aria-label="Farcaster" placeholder="Farcaster" className={inputClass} {...register("farcaster")} />
                        </div>
                        <label className="grid gap-1.5">
                          <span className="text-xs font-medium text-ink-muted">
                            Fee wallet — defaults to your connected wallet
                          </span>
                          <input
                            aria-label="Fee wallet"
                            placeholder={address ?? "0x…"}
                            className={`${inputClass} font-mono`}
                            {...register("feeWallet")}
                          />
                          {formState.errors.feeWallet && (
                            <span className="text-xs text-rose">Enter a valid 0x address or leave blank.</span>
                          )}
                        </label>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Arm + CTA */}
            <div className="grid gap-3 border-t border-border pt-5">
              {!address && <p className="text-sm text-gold">Connect a wallet to launch.</p>}
              <div className="flex items-center justify-between gap-4">
                <ArmSwitch armed={armed} onChange={setArmed} disabled={uploading} />
                <span className="text-xs text-ink-faint">
                  {armed ? "Armed — ready to review" : "Arm the switch to enable launch"}
                </span>
              </div>
              <button
                type="button"
                data-testid="launch-cta"
                className="btn-primary w-full justify-center py-3 text-base"
                disabled={!canReview}
                onClick={openReview}
              >
                {ctaLabel}
              </button>
            </div>
          </div>
        </form>

        {/* ── Right: sticky "Your token" preview ─────────────────────────── */}
        <aside className="h-fit lg:sticky lg:top-4">
          <div className="surface-card relative overflow-hidden !border-gold/25 p-5">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold/10 blur-3xl"
            />
            <div className="relative">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-semibold text-ink">Your token</span>
                <span className="chip border-gold/30 !bg-gold/10 !py-0.5 text-[0.65rem] uppercase tracking-wider text-gold">
                  Preview
                </span>
              </div>

              <div className="mb-5 flex items-center gap-3">
                {values.logo ? (
                  <img
                    src={safeImageSrc(values.logo)}
                    alt=""
                    onError={onLogoError}
                    className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-gold/30"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-2 text-ink-faint">
                    <FaEthereum aria-hidden />
                  </div>
                )}
                <div className="min-w-0">
                  <motion.div
                    key={values.name || "untitled"}
                    initial={{ opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                    className="truncate text-lg font-bold text-ink"
                  >
                    {values.name || "Untitled token"}
                  </motion.div>
                  <div className="truncate font-mono text-xs uppercase text-ink-muted">
                    {values.symbol || "TICKER"}
                  </div>
                </div>
              </div>

              <div className="divide-y divide-border border-y border-border">
                <SpecRow label="Launch fee">
                  <FaEthereum aria-hidden className="text-ink-faint" />
                  <span className="tnum">{launchFee === undefined ? "…" : formatEth(launchFee)}</span>
                </SpecRow>
                <SpecRow label="Paired with">
                  <FaEthereum aria-hidden className="text-accent" /> ETH
                </SpecRow>
                <SpecRow label="Trade fee">
                  <span className="tnum">1.00%</span>
                </SpecRow>
                <SpecRow label="Launch window" hint="Anti-snipe window at launch">
                  2 blocks
                </SpecRow>
                <SpecRow label="Graduation" hint="Threshold to graduate to the DEX">
                  <span className="tnum">4.2 ETH</span>
                </SpecRow>
                <SpecRow label="Liquidity">
                  <LuLock aria-hidden className="text-gold" /> Locked
                </SpecRow>
              </div>

              {showPredicted && (
                <div
                  data-testid="predicted-address"
                  className="mt-4 rounded-xl border border-border bg-surface-2 p-3"
                >
                  <div className="text-[0.65rem] uppercase tracking-wider text-ink-faint">
                    Predicted address
                  </div>
                  <div className="mt-1 font-mono text-xs text-ink" title={predicted ?? undefined}>
                    <span aria-hidden>{predicted ? shortAddress(predicted) : "computing…"}</span>
                    {predicted && <span className="sr-only">{predicted}</span>}
                  </div>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between rounded-xl border border-accent/25 bg-accent/5 px-3 py-3">
                <span className="text-sm text-ink-muted">ETH due</span>
                <motion.span
                  key={totalValue?.toString() ?? "na"}
                  initial={{ opacity: 0, y: 2 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  data-testid="summary-total"
                  className="tnum text-base font-bold text-ink"
                >
                  {totalValue === undefined ? "…" : formatEth(totalValue)}
                </motion.span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <Modal
        open={pending !== null}
        danger
        title="Confirm launch"
        question="This deploys your token and moves ETH. It cannot be undone. Launch now?"
        confirmLabel="Launch token"
        cancelLabel="Back"
        confirmDisabled={isPending || Boolean(hash)}
        onConfirm={confirmLaunch}
        onCancel={() => setPending(null)}
      >
        {pending && (
          <>
            <Fact label="Name">{pending.params.name}</Fact>
            <Fact label="Symbol">{pending.params.symbol}</Fact>
            <Fact label="Predicted address" mono>
              {pending.predicted ? shortAddress(pending.predicted) : "—"}
            </Fact>
            <Fact label="Total">{formatEth(pending.value)}</Fact>
          </>
        )}
      </Modal>
    </div>
  );
}
