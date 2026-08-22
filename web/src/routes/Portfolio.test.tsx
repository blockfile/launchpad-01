import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../test/setup";
import holdings from "../lib/indexer/fixtures/holdings.json";

const MANUAL_TOKEN = "0x7777777777777777777777777777777777777777";

// The whole `wagmi` surface is mocked (same approach as TradePanel.test.tsx):
// `useAccount` supplies a fixed connected wallet, and `useReadContract` is
// dispatched by `functionName` so the manual "add token by address" row's
// `balanceOf` read is deterministic without a real WagmiProvider/chain.
const h = vi.hoisted(() => ({
  account: "0x1111111111111111111111111111111111111111" as `0x${string}` | undefined,
  manualBalance: 42n * 10n ** 18n,
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: h.account }),
  useReadContract: (cfg: { functionName?: string; query?: { enabled?: boolean } }) => {
    const enabled = cfg?.query?.enabled ?? true;
    if (!enabled) return { data: undefined, isLoading: false };
    if (cfg?.functionName === "balanceOf") {
      return { data: h.manualBalance, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  },
}));

// `Portfolio` is imported after the `vi.mock("wagmi", ...)` call above so the
// module it imports `useAccount`/`useReadContract` from is already mocked.
import Portfolio from "./Portfolio";

function renderPortfolio() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Portfolio />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Portfolio", () => {
  beforeEach(() => {
    h.account = "0x1111111111111111111111111111111111111111";
    h.manualBalance = 42n * 10n ** 18n;
  });

  it("renders each indexed holding (name/symbol/balance/value) linked to its token page", async () => {
    renderPortfolio();

    expect(await screen.findByText("Pons Test Token")).toBeInTheDocument();
    expect(screen.getByText("PONS")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pons test token/i })).toHaveAttribute(
      "href",
      `/token/${holdings.items[0].tokenAddress}`,
    );
    // balance "250000000000000000000000" wei → 250000 whole tokens.
    expect(screen.getByText("250,000")).toBeInTheDocument();
    // valueEth "30.862500000000000000" is already human-decimal — rendered directly.
    expect(screen.getByText(/30\.8625/)).toBeInTheDocument();
  });

  it("shows an em dash for valueEth on a token with no trades yet (null pre-first-trade)", async () => {
    renderPortfolio();

    const row = (await screen.findByText("Untraded Test Token")).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      `/token/${holdings.items[1].tokenAddress}`,
    );
  });

  it("adds a manually-entered token address as a balanceOf-backed row, clearly labeled as not indexed", async () => {
    renderPortfolio();
    await screen.findByText("Pons Test Token");

    fireEvent.change(screen.getByLabelText(/token address/i), {
      target: { value: MANUAL_TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    const row = (await screen.findByText(/added manually/i)).closest("tr")!;
    // 42n * 10^18 wei → "42" whole tokens, read via the mocked balanceOf.
    expect(within(row).getByText("42")).toBeInTheDocument();
    expect(within(row).getByRole("link")).toHaveAttribute("href", `/token/${MANUAL_TOKEN}`);

    // It wasn't in the holdings fixture at all.
    expect(holdings.items.some((item) => item.tokenAddress === MANUAL_TOKEN)).toBe(false);
  });

  it("rejects an invalid manual address without adding a row", async () => {
    renderPortfolio();
    await screen.findByText("Pons Test Token");

    fireEvent.change(screen.getByLabelText(/token address/i), {
      target: { value: "not-an-address" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/valid token address/i);
    expect(screen.queryByText(/added manually/i)).not.toBeInTheDocument();
  });

  it("prompts to connect a wallet instead of querying holdings when disconnected", () => {
    h.account = undefined;
    renderPortfolio();

    expect(screen.getByText(/connect a wallet/i)).toBeInTheDocument();
    expect(screen.queryByText("Pons Test Token")).not.toBeInTheDocument();
  });

  it("appends a second page of holdings via Load more when nextCursor is non-null", async () => {
    const holding = (tokenAddress: string, name: string, symbol: string) => ({
      tokenAddress,
      symbol,
      name,
      logo: "https://example.com/logo.png",
      balance: "1000000000000000000",
      valueEth: null,
    });
    const page1 = {
      items: [holding("0x1111111111111111111111111111111111111111", "Holding One", "H1")],
      nextCursor: "holdings-2",
    };
    const page2 = {
      items: [holding("0x2222222222222222222222222222222222222222", "Holding Two", "H2")],
      nextCursor: null,
    };
    server.use(
      http.get("*/wallets/:address/holdings", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        return HttpResponse.json(cursor === "holdings-2" ? page2 : page1);
      }),
    );

    renderPortfolio();
    expect(await screen.findByText("Holding One")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByText("Holding Two")).toBeInTheDocument();
    expect(screen.getByText("Holding One")).toBeInTheDocument();
  });
});
