import { useEffect, useState } from "react";
import { memeApi } from "./api";
import { amount, price, money, safeUrl, shortAddress } from "./display";
import { forgetExecution, pendingExecutionId } from "./transaction-tracker";
import type { AccountSummary, AccountTransaction } from "./types";

export interface PortfolioProps {
  walletAddress?: string;
  explorerBaseUrl?: string;
  onSell: (tokenAddress: string) => void;
  onToken?: (tokenAddress: string) => void;
  refreshKey?: number;
  tokenFilter?: string;
}

export function Portfolio(props: PortfolioProps) {
  if (!props.walletAddress)
    return (
      <section className="panel empty">
        <h2>Positions & Orders</h2>
        <p>Connect wallet to view your positions and orders.</p>
      </section>
    );
  return (
    <PortfolioAccount
      key={props.walletAddress.toLowerCase()}
      {...props}
      walletAddress={props.walletAddress}
    />
  );
}

function PortfolioAccount({
  walletAddress,
  explorerBaseUrl,
  onSell,
  onToken,
  refreshKey,
  tokenFilter,
}: PortfolioProps & { walletAddress: string }) {
  const [tab, setTab] = useState<"positions" | "orders">("positions");
  const [positions, setPositions] = useState<AccountSummary["positions"] | null>(null);
  const [orderFilter, setOrderFilter] = useState<"ALL" | "CONFIRMED" | "FAILED">("ALL");
  const [orders, setOrders] = useState<AccountTransaction[] | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [shareText, setShareText] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setPositionError(null);
    setOrderError(null);
    // Users hold nothing on chain; positions are the backend ledger for this login.
    void memeApi
      .getAccount(controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) setPositions(summary.positions);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setPositionError(cause instanceof Error ? cause.message : "Positions unavailable");
      });
    let timer: ReturnType<typeof setTimeout>;
    const loadOrders = () => {
      void memeApi
        .getAccountTransactions(controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setOrders(page.items);
          setOrderError(null);
          const saved = pendingExecutionId(walletAddress);
          const resolved = page.items.find(
            (row) => row.executionId === saved && ["CONFIRMED", "FAILED"].includes(row.status),
          );
          if (resolved) forgetExecution(walletAddress, resolved.executionId);
          if (
            page.items.some(
              (row) => row.status === "PENDING" || row.status === "SUBMISSION_UNKNOWN",
            )
          )
            timer = setTimeout(loadOrders, 3000);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setOrderError(cause instanceof Error ? cause.message : "Orders unavailable");
          timer = setTimeout(loadOrders, 5000);
        });
    };
    if (!tokenFilter) loadOrders();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [walletAddress, refreshKey, tokenFilter]);

  const visiblePositions = positions?.filter(
    (position) => !tokenFilter || position.tokenAddress.toLowerCase() === tokenFilter.toLowerCase(),
  );
  const visibleOrders = orders?.filter(
    (order) => orderFilter === "ALL" || order.status === orderFilter,
  );
  const explorer = safeUrl(explorerBaseUrl)?.replace(/\/$/, "");
  return (
    <section className="panel portfolio">
      {!tokenFilter && (
        <div className="tabs" role="tablist" aria-label="Positions and orders">
          <button
            role="tab"
            aria-selected={tab === "positions"}
            onClick={() => setTab("positions")}
          >
            Positions
          </button>
          <button role="tab" aria-selected={tab === "orders"} onClick={() => setTab("orders")}>
            Order history
          </button>
        </div>
      )}
      {tab === "positions" ? (
        <>
          {positionError && <p role="alert">{positionError}</p>}
          {!positions && !positionError && <p role="status">Loading positions…</p>}
          {visiblePositions?.length === 0 && <p className="empty">No positions</p>}
          {visiblePositions && visiblePositions.length > 0 && (
            <div className="table-scroll">
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Amount</th>
                    <th>Value</th>
                    <th>PnL</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visiblePositions.map((position) => {
                    const owned = Number(position.available) > 0;
                    return (
                      <tr key={position.tokenAddress}>
                        <td>
                          <button
                            className="portfolio-token"
                            title={position.tokenAddress}
                            onClick={() => onToken?.(position.tokenAddress)}
                          >
                            <span>{position.symbol || shortAddress(position.tokenAddress)}</span>
                          </button>
                        </td>
                        <td title={position.available}>
                          {amount(position.available)}
                          {position.frozen && Number(position.frozen) > 0 && (
                            <small>Selling {amount(position.frozen)}</small>
                          )}
                        </td>
                        <td>{money(position.valueUsd)}</td>
                        <td>
                          {money(
                            position.valueUsd != null && position.costUsd != null
                              ? Number(position.valueUsd) - Number(position.costUsd)
                              : null,
                          )}
                        </td>
                        <td>
                          <button
                            disabled={!owned}
                            onClick={() => onSell(position.tokenAddress)}
                            className="portfolio-sell"
                          >
                            Sell
                          </button>
                          <button
                            className="portfolio-share"
                            onClick={() => {
                              setShareText(
                                `Token ${position.tokenAddress}\nAmount: ${position.available}\nValue: ${money(position.valueUsd)}\n${window.location.origin}${window.location.pathname}#token/${position.tokenAddress}`,
                              );
                            }}
                          >
                            Share
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="tabs" aria-label="Order status">
            {(
              [
                ["ALL", "All"],
                ["CONFIRMED", "Filled"],
                ["FAILED", "Failed"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={orderFilter === value}
                onClick={() => setOrderFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {orderError && <p role="alert">{orderError}</p>}
          {!orders && !orderError && <p role="status">Loading orders…</p>}
          {visibleOrders?.length === 0 && <p className="empty">No orders</p>}
          {visibleOrders && visibleOrders.length > 0 && (
            <div className="table-scroll">
              <table className="orders-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Token</th>
                    <th>Side</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Fill MC</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((order) => {
                    const status =
                      order.status === "CONFIRMED"
                        ? "Filled"
                        : order.status === "FAILED"
                          ? "Failed"
                          : "Processing";
                    return (
                      <tr key={order.executionId}>
                        <td>
                          <time>{new Date(order.createdAt).toLocaleString()}</time>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            title={order.tokenAddress}
                            onClick={() => onToken?.(order.tokenAddress)}
                          >
                            {order.tokenSymbol || shortAddress(order.tokenAddress)}
                          </button>
                        </td>
                        <td>{order.side === "BUY" ? "Buy" : "Sell"}</td>
                        <td>
                          {price(order.settlement?.amountIn ?? order.amountIn)}{" "}
                          {order.side === "BUY" ? order.settlementAsset : order.tokenSymbol}
                          {order.status === "CONFIRMED" && order.settlement && (
                            <small>
                              Received {price(order.settlement.amountOut)}{" "}
                              {order.side === "BUY" ? order.tokenSymbol : order.settlementAsset}
                            </small>
                          )}
                          {order.settlement && (
                            <small>
                              Fee {price(order.settlement.fee.amount)} {order.settlement.fee.asset}
                            </small>
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge ${status === "Failed" ? "danger" : status === "Filled" ? "positive" : "warning"}`}
                          >
                            {status}
                          </span>
                          {order.errorMessage && <small>{order.errorMessage}</small>}
                          {order.status === "SUBMISSION_UNKNOWN" && (
                            <small>Submission unconfirmed. Checking the same order.</small>
                          )}
                        </td>
                        <td>{money(order.settlement?.marketCapUsd)}</td>
                        <td>
                          {order.txHashes.map((hash) =>
                            explorer && /^0x[0-9a-f]{64}$/i.test(hash) ? (
                              <a
                                key={hash}
                                href={`${explorer}/tx/${hash}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {shortAddress(hash)}
                              </a>
                            ) : (
                              <code key={hash}>{hash}</code>
                            ),
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {shareText !== null && (
        <section className="share-card" aria-label="Position share">
          <h3>Share position</h3>
          <textarea aria-label="Position share text" readOnly value={shareText} rows={7} />
          <button
            onClick={() => {
              void navigator.clipboard
                ?.writeText(shareText)
                .then(() => setShareText(null))
                .catch(() => {});
            }}
          >
            Copy
          </button>
          <button onClick={() => setShareText(null)}>Close</button>
        </section>
      )}
    </section>
  );
}
export default Portfolio;
