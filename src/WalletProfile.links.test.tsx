import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { walletTradeTime } from "./display";
import { WalletProfile } from "./WalletProfile";
import { walletApi } from "./wallet-api";
import type { WalletActivity, WalletPosition, WalletProfileData } from "./wallet-types";
vi.mock("./wallet-api", () => ({
  walletApi: { profile: vi.fn(), positions: vi.fn(), activities: vi.fn() },
}));
vi.mock("./user-state", () => ({
  useUserState: () => ({ userId: null, followed: new Set(), notes: new Map() }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const now = 1800000000000;
it.each([
  [1, "1 second"],
  [59, "59 seconds"],
  [60, "1min"],
  [4980, "1h 23min"],
  [93540, "1d 1h 59min"],
])("formats %s seconds", (seconds, expected) => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  expect(walletTradeTime(now - Number(seconds) * 1000)).toBe(expected);
});
it("keeps future time at zero and missing/invalid time unknown", () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  expect(walletTradeTime(now + 10000)).toBe("0 seconds");
  for (const value of [null, undefined, NaN]) expect(walletTradeTime(value)).toBe("—");
});
const address = `0x${"1".repeat(40)}`;
const hash = `0x${"2".repeat(64)}`;
it.each([
  [4663, hash, true],
  [4663, "", false],
  [4663, "0xinvalid", false],
  [1, hash, false],
])("renders valid chain/hash links (%s, %s)", async (chainId, txHash, linked) => {
  vi.mocked(walletApi.profile).mockResolvedValue({
    chainId,
    address,
    labels: [],
  } as unknown as WalletProfileData);
  vi.mocked(walletApi.positions).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(walletApi.activities).mockResolvedValue({
    items: [
      {
        eventId: "1",
        chainId,
        txHash,
        token: address,
        tokenName: "Actual Token",
        tokenSymbol: "ACT",
        kind: "SELL",
        amountUsd: null,
        marketCapUsd: "12345",
        timestampMs: now - 4980000,
      } as WalletActivity,
    ],
    nextCursor: null,
  });
  const onToken = vi.fn();
  render(<WalletProfile address={address} onClose={() => {}} onToken={onToken} />);
  const token = await screen.findByRole("button", { name: "ACT" });
  const row = token.closest("tr")!;
  expect(within(row).getByText("Sell")).toBeVisible();
  expect(within(row).getByText("—")).toHaveAttribute("title", "Fill MC $12,345");
  fireEvent.click(token);
  expect(onToken).toHaveBeenCalledWith(address);
  expect(screen.getByRole("button", { name: `Copy wallet address ${address}` })).toBeVisible();
  const tx = screen.queryByRole("link", { name: /View transaction/ });
  expect(Boolean(tx)).toBe(linked);
  const wallet = screen.queryByRole("link", { name: /View wallet address/ });
  expect(Boolean(wallet)).toBe(chainId === 4663);
  for (const [link, path] of [
    [tx, `tx/${hash}`],
    [wallet, `address/${address}`],
  ] as const) {
    if (!link) continue;
    expect(link).toHaveAttribute("href", `https://robinhoodchain.blockscout.com/${path}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

it("retains returned holdings and shows a separate notice only for partial historical coverage", async () => {
  vi.mocked(walletApi.profile).mockResolvedValue({
    chainId: 4663,
    address,
    labels: [],
  } as unknown as WalletProfileData);
  vi.mocked(walletApi.activities).mockResolvedValue({ items: [], nextCursor: null });
  const position = {
    token: address,
    symbol: "KEEP",
    quantityComplete: true,
    quantityAtomic: "100",
    decimals: 0,
    valueUsd: "25",
  } as WalletPosition;
  vi.mocked(walletApi.positions)
    .mockResolvedValueOnce({ items: [position], nextCursor: "next" })
    .mockResolvedValueOnce({
      items: [{ ...position, token: `0x${"3".repeat(40)}`, symbol: "ALSO" }],
      nextCursor: null,
      projectionCoverage: "PARTIAL_LEGACY_UNCONFIRMED",
      unverifiedPositionCount: 2,
    });
  render(<WalletProfile address={address} onClose={() => {}} onToken={() => {}} />);
  await screen.findByRole("button", { name: "KEEP" });
  expect(
    screen.queryByText("Some historical holdings cannot be verified."),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more positions" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Some historical holdings cannot be verified.",
  );
  expect(screen.getByRole("button", { name: "KEEP" })).toBeVisible();
  expect(screen.getByRole("button", { name: "ALSO" })).toBeVisible();
  expect(screen.getAllByText("$25")).toHaveLength(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  cleanup();
  vi.mocked(walletApi.positions).mockResolvedValue({
    items: [position],
    nextCursor: null,
    projectionCoverage: "PARTIAL_LEGACY_UNCONFIRMED",
    unverifiedPositionCount: 1,
  });
  render(<WalletProfile address={address} onClose={() => {}} onToken={() => {}} />);
  expect(await screen.findByRole("button", { name: "KEEP" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Some historical holdings cannot be verified.",
  );
});

it("shows unknown trade counts as a dash and preserves actual numeric counts", async () => {
  vi.mocked(walletApi.positions).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(walletApi.activities).mockResolvedValue({ items: [], nextCursor: null });
  for (const [buyCount, sellCount, expected] of [
    [null, null, "—"],
    [null, 3, "—"],
    [2, null, "—"],
    [2, 3, "2 / 3"],
    [0, 0, "0 / 0"],
  ] as const) {
    vi.mocked(walletApi.profile).mockResolvedValue({
      chainId: 4663,
      address,
      labels: [],
      stats: { buyCount, sellCount },
    } as unknown as WalletProfileData);
    render(<WalletProfile address={address} onClose={() => {}} onToken={() => {}} />);
    await waitFor(() =>
      expect(screen.getByLabelText("7d buys / sells")).toHaveTextContent(expected),
    );
    cleanup();
  }
});

it("marks numeric trade counts only when the history window is explicitly incomplete", async () => {
  vi.mocked(walletApi.positions).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(walletApi.activities).mockResolvedValue({ items: [], nextCursor: null });
  for (const [windowComplete, buyCount, sellCount, expected, notice] of [
    [false, 43, 63, "43 / 63", true],
    [false, 0, 0, "0 / 0", true],
    [true, 43, 63, "43 / 63", false],
    [undefined, 43, 63, "43 / 63", false],
    [false, null, 63, "—", false],
    [false, 43, null, "—", false],
  ] as const) {
    vi.mocked(walletApi.profile).mockResolvedValue({
      chainId: 4663,
      address,
      labels: [],
      windowComplete,
      stats: { buyCount, sellCount },
    } as unknown as WalletProfileData);
    render(<WalletProfile address={address} onClose={() => {}} onToken={() => {}} />);
    const count = screen.getByLabelText("7d buys / sells");
    await waitFor(() => expect(count).toHaveTextContent(expected));
    expect(Boolean(within(count.parentElement!).queryByText("Incomplete history"))).toBe(notice);
    cleanup();
  }
});
