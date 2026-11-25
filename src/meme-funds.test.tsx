import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MemeFunds from "./MemeFunds";
import TradingPanel from "./TradingPanel";
import { memeAccountApi, memeApi, setAzToken, type MemeBalance } from "./api";
import type { AccountSummary, Quote, Token } from "./types";

const tokenAddress = `0x${"2".repeat(40)}`;
const zero = { tradeFrozen: "0", withdrawFrozen: "0", frozen: "0" };
const balances: MemeBalance[] = [
  { currency: "USDC", total: "0", available: "0", ...zero },
  { currency: "USDG", total: "0.5", available: "0.5", ...zero },
  { currency: "USDT", total: "2", available: "2", ...zero },
];
const quota = {
  enabled: true,
  limitUsd: "1000",
  remainingBuyUsd: "999",
  netBoughtUsd: "1",
  inFlightBuyUsd: "0",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  setAzToken(null);
});

function mockAccount() {
  vi.spyOn(memeAccountApi, "balances").mockResolvedValue({ userId: "1", balances, quota });
  vi.spyOn(memeAccountApi, "transfers").mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(memeAccountApi, "bills").mockResolvedValue({ items: [], nextCursor: null });
}

describe("meme account funds", () => {
  it("asks for the AZ login before reading funds", () => {
    const balancesSpy = vi.spyOn(memeAccountApi, "balances");
    const onConnect = vi.fn(async () => true);
    render(<MemeFunds onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Log in to AZ" }));
    expect(onConnect).toHaveBeenCalled();
    expect(balancesSpy).not.toHaveBeenCalled();
  });

  it("transfers in from spot with a fresh request id and blocks withdrawing above available", async () => {
    setAzToken("az-jwt");
    mockAccount();
    const deposit = vi.spyOn(memeAccountApi, "deposit").mockResolvedValue({
      transferId: "7",
      requestId: "web-x",
      direction: "DEPOSIT",
      peerAccountType: "SPOT",
      currency: "USDT",
      amount: "3",
      status: "CREDITED",
      failureCode: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
    });
    const onChange = vi.fn();
    render(<MemeFunds onChange={onChange} />);
    expect(await screen.findByText("Net buy quota: 1 / 1000 U used, 999 U left")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Transfer amount"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Transfer in" }));
    await waitFor(() =>
      expect(deposit).toHaveBeenCalledWith({
        requestId: expect.stringMatching(/^web-/),
        sourceAccountType: "SPOT",
        currency: "USDT",
        amount: "3",
      }),
    );
    expect(await screen.findByText("Transfer in 3 USDT: CREDITED")).toBeVisible();
    expect(onChange).toHaveBeenCalled();

    const withdraw = vi.spyOn(memeAccountApi, "withdraw");
    fireEvent.click(screen.getByRole("tab", { name: "Transfer out" }));
    fireEvent.change(screen.getByLabelText("Transfer amount"), { target: { value: "2.5" } });
    expect(screen.getByText("Amount exceeds available balance")).toBeVisible();
    expect(screen.getByRole("button", { name: "Transfer out" })).toBeDisabled();
    expect(withdraw).not.toHaveBeenCalled();
  });
});

describe("trading panel spend currency", () => {
  const account: AccountSummary = {
    fundingModel: "SHARED_TREASURY",
    treasury: {
      address: `0x${"9".repeat(40)}`,
      balances: [{ asset: "USDG", available: "100", frozen: "0" }],
    },
    quoteBalances: balances.map((b) => ({
      asset: b.currency,
      available: b.available,
      frozen: "0",
    })),
    positions: [],
  };
  const quote = {
    quoteId: "q",
    tokenAddress,
    side: "BUY",
    settlementAsset: "USDG",
    amountIn: "0.05",
    expectedAmountOut: "1",
    minAmountOut: "0.9",
    targetOut: "1",
    minOut: "0.9",
    slippageBps: 500,
    configuredFeeBps: "0",
    effectiveFeeBps: "0",
    feeConfigVersion: "2",
    fees: [{ type: "SERVICE", asset: "USDG", amount: "0", estimated: true }],
    expiresAt: Date.now() + 60_000,
    idealOut: "1",
    feeRecipient: `0x${"0".repeat(40)}`,
    routeFingerprint: "r",
    routePools: [{ poolKey: "p", poolType: "V2", liquidityUsd: "1000" }],
    routeAssets: [
      { address: `0x${"5".repeat(40)}`, symbol: "USDG", decimals: 6 },
      { address: tokenAddress, symbol: "MEME", decimals: 18 },
    ],
  } as Quote;

  it("pays a buy from the ledger currency the user holds most and honors the backend minimum", async () => {
    vi.spyOn(memeApi, "createQuote").mockResolvedValue(quote as never);
    const execute = vi.spyOn(memeApi, "executeMainAccountTrade").mockResolvedValue({
      executionId: "e",
      status: "PENDING",
    } as never);
    render(
      <TradingPanel
        token={{ tokenAddress, symbol: "MEME", tradeStatus: "TRADABLE" } as Token}
        account={account}
        walletAddress={`0x${"1".repeat(40)}`}
        onAccountRefresh={vi.fn()}
        minBuyAmountUsd="0.01"
      />,
    );
    expect(screen.getByText("2 USDT", { selector: ".trade-balance-value" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "0.005" } });
    expect(screen.getByText("Buy amount must be between 0.01 and 9,999,999 U")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "3" } });
    expect(screen.getByText("Insufficient Balance")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Trade amount"), { target: { value: "0.05" } });
    const buy = await screen.findByRole("button", { name: "Buy 0.05 USDT" });
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ side: "BUY", amountIn: "0.05", spendCurrency: "USDT" }),
      ),
    );
  });
});
