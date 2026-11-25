import { useEffect, useState } from "react";
import {
  ApiError,
  hasAzToken,
  memeAccountApi,
  type LedgerCurrency,
  type MemeBalance,
  type MemeBill,
  type MemeQuota,
  type MemeTransfer,
  type PeerAccountType,
} from "./api";
import { compareAmounts } from "./quote-flow";

export interface MemeFundsProps {
  refreshKey?: number;
  onConnect?: () => Promise<boolean>;
  /** Called after a transfer settles so balances elsewhere on the page reload. */
  onChange?: () => void;
}

const currencies: LedgerCurrency[] = ["USDT", "USDC", "USDG"];
const peers: Array<[PeerAccountType, string]> = [
  ["SPOT", "Spot"],
  ["FUTURES_U", "USDⓈ-M Futures"],
];
const finalStatuses = new Set(["CREDITED", "COMPLETED", "FAILED"]);
const message = (cause: unknown) =>
  cause instanceof ApiError
    ? `${cause.message} (${cause.code})`
    : cause instanceof Error
      ? cause.message
      : String(cause);

/** meme-account funds: balances, transfers in from / out to AZ accounts, transfer and bill history. */
export function MemeFunds({ refreshKey, onConnect, onChange }: MemeFundsProps) {
  const [balances, setBalances] = useState<MemeBalance[] | null>(null);
  const [quota, setQuota] = useState<MemeQuota | null>(null);
  const [transfers, setTransfers] = useState<MemeTransfer[] | null>(null);
  const [bills, setBills] = useState<MemeBill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [direction, setDirection] = useState<"DEPOSIT" | "WITHDRAW">("DEPOSIT");
  const [peer, setPeer] = useState<PeerAccountType>("SPOT");
  const [currency, setCurrency] = useState<LedgerCurrency>("USDT");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const loggedIn = hasAzToken();

  useEffect(() => {
    if (!loggedIn) return;
    let active = true;
    setLoadError(null);
    void Promise.all([
      memeAccountApi.balances(),
      memeAccountApi.transfers(),
      memeAccountApi.bills(),
    ])
      .then(([summary, transferPage, billPage]) => {
        if (!active) return;
        setBalances(summary.balances);
        setQuota(summary.quota);
        setTransfers(transferPage.items);
        setBills(billPage.items);
      })
      .catch((cause: unknown) => {
        if (active) setLoadError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [loggedIn, refreshKey, revision]);

  if (!loggedIn)
    return (
      <section className="meme-funds">
        <p>AZ login is required to view and move meme account funds.</p>
        <button className="primary" onClick={() => void onConnect?.()}>
          Log in to AZ
        </button>
      </section>
    );

  const available = balances?.find((row) => row.currency === currency)?.available ?? "0";
  const invalid = !/^\d+(?:\.\d+)?$/.test(amount.trim())
    ? "Enter an amount"
    : compareAmounts(amount.trim(), "0") <= 0
      ? "Enter an amount greater than 0"
      : direction === "WITHDRAW" && compareAmounts(amount.trim(), available) > 0
        ? "Amount exceeds available balance"
        : null;

  async function submit() {
    setBusy(true);
    setSubmitError(null);
    setResult(null);
    const requestId = `web-${crypto.randomUUID()}`;
    try {
      const value = amount.trim();
      const row =
        direction === "DEPOSIT"
          ? await memeAccountApi.deposit({
              requestId,
              sourceAccountType: peer,
              currency,
              amount: value,
            })
          : await memeAccountApi.withdraw({
              requestId,
              targetAccountType: peer,
              currency,
              amount: value,
            });
      setResult(
        `${row.direction === "DEPOSIT" ? "Transfer in" : "Transfer out"} ${row.amount} ${row.currency}: ${row.status}${row.failureCode ? ` (${row.failureCode})` : ""}`,
      );
      if (finalStatuses.has(row.status)) setAmount("");
    } catch (cause) {
      setSubmitError(message(cause));
    } finally {
      setBusy(false);
      setRevision((n) => n + 1);
      onChange?.();
    }
  }

  return (
    <section className="meme-funds" aria-label="Meme account funds">
      {loadError && <p role="alert">{loadError}</p>}
      <div className="table-scroll">
        <table className="funds-table">
          <thead>
            <tr>
              <th>Currency</th>
              <th>Total</th>
              <th>Available</th>
              <th>Frozen (trade / withdraw)</th>
            </tr>
          </thead>
          <tbody>
            {(balances ?? []).map((row) => (
              <tr key={row.currency}>
                <td>{row.currency}</td>
                <td>{row.total}</td>
                <td>{row.available}</td>
                <td>
                  {row.frozen} ({row.tradeFrozen} / {row.withdrawFrozen})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!balances && !loadError && <p role="status">Loading balances…</p>}
      {quota?.enabled && (
        <p className="muted">
          Net buy quota: {quota.netBoughtUsd} / {quota.limitUsd} U used, {quota.remainingBuyUsd} U
          left
        </p>
      )}

      <form
        className="funds-transfer"
        aria-label="Transfer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid && !busy) void submit();
        }}
      >
        <div className="tabs" role="tablist" aria-label="Transfer direction">
          {(
            [
              ["DEPOSIT", "Transfer in"],
              ["WITHDRAW", "Transfer out"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={direction === value}
              onClick={() => setDirection(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label>
          {direction === "DEPOSIT" ? "From" : "To"}
          <select
            aria-label="AZ account"
            value={peer}
            onChange={(e) => setPeer(e.target.value as PeerAccountType)}
          >
            {peers.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <select
            aria-label="Transfer currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as LedgerCurrency)}
          >
            {currencies.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Amount
          <input
            aria-label="Transfer amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        {direction === "WITHDRAW" && (
          <button type="button" onClick={() => setAmount(available)}>
            Max {available}
          </button>
        )}
        <button className="primary" type="submit" disabled={busy || Boolean(invalid)}>
          {busy ? "Processing…" : direction === "DEPOSIT" ? "Transfer in" : "Transfer out"}
        </button>
        {amount && invalid && <p className="trade-error">{invalid}</p>}
        {result && <p role="status">{result}</p>}
        {submitError && <p role="alert">{submitError}</p>}
      </form>

      <h3>Transfers</h3>
      <div className="table-scroll">
        <table className="transfers-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Direction</th>
              <th>AZ account</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(transfers ?? []).map((row) => (
              <tr key={row.transferId}>
                <td>
                  <time>{new Date(row.createdAt).toLocaleString()}</time>
                </td>
                <td>{row.direction === "DEPOSIT" ? "In" : "Out"}</td>
                <td>{row.peerAccountType}</td>
                <td>
                  {row.amount} {row.currency}
                </td>
                <td>
                  {row.status}
                  {row.failureCode && <small> {row.failureCode}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {transfers?.length === 0 && <p className="empty">No transfers</p>}

      <h3>Bills</h3>
      <div className="table-scroll">
        <table className="bills-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Balance</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {(bills ?? []).map((row) => (
              <tr key={row.billId}>
                <td>
                  <time>{new Date(row.createdAt).toLocaleString()}</time>
                </td>
                <td>{row.billType}</td>
                <td>
                  {row.side === 1 ? "+" : "-"}
                  {row.amount} {row.currency}
                </td>
                <td>
                  {row.beforeBalance} → {row.afterBalance}
                </td>
                <td title={row.refId}>{row.refType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bills?.length === 0 && <p className="empty">No bills</p>}
    </section>
  );
}

export default MemeFunds;
