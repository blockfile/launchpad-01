import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router";
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { parseEther, parseEventLogs } from "viem";
import { launchFactoryAbi } from "@launchpad/shared";
import { resolveAddress, resolveAddressOptional } from "../lib/contracts";
import { usePredictedTokenAddress, useAvailableLaunchConfigs } from "../lib/launchConfig";
import { LogoField } from "../components/LogoField";
import { LaunchpadUnavailableNotice } from "../components/NetworkNotice";
import { WrongNetworkBanner } from "../components/WrongNetworkBanner";
import { ArmSwitch } from "../components/ui/ArmSwitch";
import { Fact, Modal } from "../components/ui/Modal";
import { formatEth, shortAddress } from "../lib/format";
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
  const canReview =
    armed &&
    formState.isValid &&
    Boolean(address) &&
    launchFee !== undefined &&
    !uploading &&
    !pending;

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
      <div className="mx-auto max-w-xl p-6 text-slate-100">
        <h1 className="mb-4 text-2xl font-semibold">Launch a token</h1>
        <LaunchpadUnavailableNotice />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6 text-slate-100">
      <h1 className="mb-4 text-2xl font-semibold">Launch a token</h1>

      <WrongNetworkBanner />

      <form className="mt-4 grid gap-4" onSubmit={(e) => e.preventDefault()}>
        <label className="grid gap-1">
          <span>Name</span>
          <input aria-label="Name" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("name")} />
        </label>

        <label className="grid gap-1">
          <span>Symbol</span>
          <input aria-label="Symbol" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("symbol")} />
        </label>

        <label className="grid gap-1">
          <span>Description</span>
          <textarea aria-label="Description" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("description")} />
        </label>

        <LogoField
          value={values.logo}
          onChange={(uri) => setValue("logo", uri, { shouldValidate: true, shouldDirty: true })}
          onUploading={setUploading}
        />
        {formState.errors.logo && <span className="text-sm text-red-400">{formState.errors.logo.message}</span>}

        <fieldset className="grid gap-2">
          <legend className="text-slate-400">Socials (optional)</legend>
          <input aria-label="Twitter" placeholder="Twitter" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("twitter")} />
          <input aria-label="Telegram" placeholder="Telegram" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("telegram")} />
          <input aria-label="Discord" placeholder="Discord" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("discord")} />
          <input aria-label="Website" placeholder="Website" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("website")} />
          <input aria-label="Farcaster" placeholder="Farcaster" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("farcaster")} />
        </fieldset>

        <label className="grid gap-1">
          <span>Fee wallet (optional — defaults to your connected wallet)</span>
          <input aria-label="Fee wallet" placeholder={address ?? "0x…"} className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("feeWallet")} />
          {formState.errors.feeWallet && <span className="text-sm text-red-400">Enter a valid 0x address or leave blank.</span>}
        </label>

        <label className="grid gap-1">
          <span>Dev buy (ETH)</span>
          <input aria-label="Dev buy (ETH)" inputMode="decimal" placeholder="0" className="rounded border border-slate-700 bg-transparent px-2 py-1" {...register("devBuyEth")} />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="grid gap-1">
            <span>Launch config</span>
            <select
              aria-label="Launch config"
              className="rounded border border-slate-700 bg-transparent px-2 py-1"
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
          <label className="grid gap-1">
            <span>DEX</span>
            <select
              aria-label="DEX"
              className="rounded border border-slate-700 bg-transparent px-2 py-1"
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

        {showPredicted && (
          <div data-testid="predicted-address" className="rounded border border-slate-800 p-3 text-sm">
            <span className="text-slate-400">Predicted token address</span>
            <div className="addr break-all">{predicted ?? "computing…"}</div>
            <button type="button" className="ghost mt-1 text-xs text-slate-400" onClick={() => setSalt(randomSalt())}>
              Reroll address
            </button>
          </div>
        )}

        {/* Read-only summary strip: launch fee + dev buy = total ETH. */}
        <dl className="grid grid-cols-3 gap-2 rounded border border-slate-800 p-3 text-sm">
          <div>
            <dt className="text-slate-400">Launch fee</dt>
            <dd>{launchFee === undefined ? "…" : formatEth(launchFee)}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Dev buy</dt>
            <dd>{formatEth(devBuyWei)}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Total</dt>
            <dd data-testid="summary-total">{totalValue === undefined ? "…" : formatEth(totalValue)}</dd>
          </div>
        </dl>

        {!address && <p className="text-sm text-amber-400">Connect a wallet to launch.</p>}

        <div className="flex items-center gap-4">
          <ArmSwitch armed={armed} onChange={setArmed} disabled={uploading} />
          <button
            type="button"
            className="rounded bg-emerald-600 px-4 py-2 font-semibold disabled:opacity-40"
            disabled={!canReview}
            onClick={openReview}
          >
            Review launch
          </button>
        </div>
      </form>

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
