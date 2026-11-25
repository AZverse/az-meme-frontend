import { forgetExecution, pendingExecutionId, rememberExecution } from "./transaction-tracker";
import { requireQuoteTerms, type QuoteRequest, type ValidQuote } from "./quote-flow";
import type {
  AccountSummary,
  AccountTransaction,
  Asset,
  Candle,
  CandleSnapshot,
  Interval,
  QuoteDisplay,
  Token,
  Trade,
} from "./types";

interface Envelope<T> {
  rc: number;
  mc: string;
  ma: string[];
  result: T;
}

export function resolveApiBaseUrl(configuredUrl: string | undefined): string {
  return configuredUrl ?? "";
}

export function resolveWsBaseUrl(
  configuredUrl: string | undefined,
  location: Pick<Location, "protocol" | "host"> = window.location,
): string {
  return (
    configuredUrl ||
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/sapi/v1/meme/stream`
  );
}

const apiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_MEME_API_BASE_URL as string | undefined);
const accountBaseUrl = (import.meta.env.VITE_MEME_ACCOUNT_BASE_URL as string | undefined) ?? "";
const azBaseUrl = (import.meta.env.VITE_AZ_API_BASE_URL as string | undefined) ?? "";
const sessionStorageKey = "az:meme:wallet-session";
const azTokenStorageKey = "az:meme:az-token";
const stored = (key: string) =>
  typeof window === "undefined" || !window.localStorage ? null : window.localStorage.getItem(key);
let sessionToken: string | null = stored(sessionStorageKey);
/** Treasury mode: quotes, trades, account and meme-account funds belong to the AZ login. */
let azToken: string | null = stored(azTokenStorageKey);
export interface SponsoredTransaction {
  from: string;
  to: string;
  data: `0x${string}`;
  value: string;
}
export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

/** Reads and unsigned estimates fail fast; writes (prepare/order/execute) keep the longer window. */
const readTimeoutMs = 5_000;
const writeTimeoutMs = 15_000;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
  if (typeof window !== "undefined" && window.localStorage) {
    if (token) window.localStorage.setItem(sessionStorageKey, token);
    else window.localStorage.removeItem(sessionStorageKey);
  }
}

export function clearSessionToken(): void {
  setSessionToken(null);
  setAzToken(null);
}

export function setAzToken(token: string | null): void {
  azToken = token;
  if (typeof window !== "undefined" && window.localStorage) {
    if (token) window.localStorage.setItem(azTokenStorageKey, token);
    else window.localStorage.removeItem(azTokenStorageKey);
  }
}

export function hasAzToken(): boolean {
  return azToken !== null;
}

/** The AZ login when present; other modes keep using the wallet session. */
function azAuthorization(): HeadersInit | undefined {
  return azToken ? { authorization: `Bearer ${azToken}` } : undefined;
}

async function readEnvelope<T>(response: Response, prefix: "MEME" | "AZ"): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError(
      `${prefix}_${response.ok ? "INVALID_RESPONSE" : "REQUEST_FAILED"}`,
      `HTTP ${response.status}: service response was interrupted. Check the connection and retry`,
      response.status,
    );
  }
  if (
    prefix === "MEME" &&
    response.status === 403 &&
    text.trim() === "Signing is available only on the private account entry"
  ) {
    throw new ApiError(
      "MEME_PRIVATE_ACCOUNT_ENTRY_REQUIRED",
      "This is the public market entry. Use the private main-account entry (Tailscale / private network) for quotes and trading",
      response.status,
    );
  }
  let payload: Partial<Envelope<T>> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch (cause) {
    if (response.ok)
      throw new ApiError(
        `${prefix}_INVALID_RESPONSE`,
        `HTTP ${response.status}: invalid service response. Retry shortly`,
        response.status,
      );
    // Non-JSON proxy failures must retain their original HTTP status below.
    if (!(cause instanceof SyntaxError)) throw cause;
  }
  if (!response.ok || (payload && typeof payload.rc === "number" && payload.rc !== 0)) {
    throw new ApiError(
      typeof payload?.mc === "string" ? payload.mc : `${prefix}_REQUEST_FAILED`,
      Array.isArray(payload?.ma) && typeof payload.ma[0] === "string"
        ? payload.ma[0]
        : `HTTP ${response.status}: request failed`,
      response.status,
      payload?.result ?? undefined,
    );
  }
  if (!payload || payload.rc !== 0 || !Object.hasOwn(payload, "result")) {
    throw new ApiError(
      `${prefix}_INVALID_RESPONSE`,
      `HTTP ${response.status}: invalid service response format`,
      response.status,
    );
  }
  return payload.result as T;
}
async function send<T>(
  base: string,
  prefix: "MEME" | "AZ",
  path: string,
  init?: RequestInit,
  publicMarket = false,
  readOnlyRequest = false,
): Promise<T> {
  init?.signal?.throwIfAborted();
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const controller = new AbortController();
  const cancel = () => controller.abort(init?.signal?.reason);
  let response: Response | undefined;
  const readMethod = ["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase());
  const timer = setTimeout(
    () => {
      const mutation = !readOnlyRequest && !readMethod;
      controller.abort(
        new ApiError(
          `${prefix}_${response && !response.ok ? "REQUEST_FAILED" : "REQUEST_TIMEOUT"}`,
          `${response ? `HTTP ${response.status}: ` : ""}Request timed out${
            mutation
              ? "; the result is unconfirmed and a trade may have been broadcast. Check trade history first and do not resubmit"
              : "; retry shortly"
          }`,
          response?.status ?? 0,
        ),
      );
    },
    readMethod || readOnlyRequest ? readTimeoutMs : writeTimeoutMs,
  );
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  init?.signal?.addEventListener("abort", cancel, { once: true });
  try {
    // Race the whole read: aborting fetch alone cannot bound an unresponsive body reader.
    return await Promise.race([
      aborted,
      (async () => {
        if (publicMarket) headers.delete("authorization");
        else if (sessionToken && !headers.has("authorization"))
          headers.set("authorization", `Bearer ${sessionToken}`);
        controller.signal.throwIfAborted();
        response = await fetch(`${base}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
          credentials: publicMarket ? "omit" : "same-origin",
        });
        controller.signal.throwIfAborted();
        return readEnvelope<T>(response, prefix);
      })(),
    ]);
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (cause instanceof ApiError) throw cause;
    throw new ApiError(
      `${prefix}_REQUEST_FAILED`,
      "Network request failed. Check the connection and retry",
      response?.status ?? 0,
    );
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
export function request<T>(path: string, init?: RequestInit): Promise<T> {
  return send(apiBaseUrl, "MEME", path, init);
}
export function requestPublicMarket<T>(path: string, init?: RequestInit): Promise<T> {
  return send(apiBaseUrl, "MEME", path, init, true);
}
export interface WalletSession {
  userId: string;
  accountId: string;
  loginAddress: string | null;
}

export async function restoreWalletSession(address: string): Promise<WalletSession | null> {
  const token = sessionToken;
  if (!token) return null;
  try {
    const session = await request<WalletSession>("/sapi/v1/meme/auth/session");
    if (token !== sessionToken) return null;
    if (session.loginAddress?.toLowerCase() !== address.toLowerCase()) {
      clearSessionToken();
      return null;
    }
    return session;
  } catch (cause) {
    if (token !== sessionToken) return null;
    if (cause instanceof ApiError && cause.status === 401) {
      clearSessionToken();
      return null;
    }
    throw cause;
  }
}

export async function authenticateWallet(address: string, provider: WalletProvider): Promise<void> {
  const nonce = await request<{ message: string }>("/sapi/v1/meme/auth/wallet/nonce", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  const signature = await provider.request({
    method: "personal_sign",
    params: [nonce.message, address],
  });
  if (typeof signature !== "string")
    throw new ApiError("MEME_WALLET_SIGNATURE_INVALID", "Invalid wallet signature", 400);
  const verified = await request<{ token: string }>("/sapi/v1/meme/auth/wallet/verify", {
    method: "POST",
    body: JSON.stringify({ address, signature }),
  });
  setSessionToken(verified.token);
}

/** AZ envelope: `{ code: 200, data, msg }`. */
async function azPost<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${azBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "api-version": "4", device: "web" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(writeTimeoutMs),
    });
  } catch {
    throw new ApiError("AZ_REQUEST_FAILED", "AZ login is unreachable. Retry shortly", 0);
  }
  const payload = (await response.json().catch(() => null)) as {
    code?: number;
    data?: T;
    msg?: string;
    error?: string;
  } | null;
  if (!response.ok || payload?.code !== 200 || payload.data === undefined)
    throw new ApiError(
      "AZ_LOGIN_FAILED",
      `AZ login failed: ${payload?.msg ?? payload?.error ?? `HTTP ${response.status}`}`,
      response.status,
    );
  return payload.data;
}

/** Same wallet, AZ web3 login: the returned access token is the AZ JWT treasury mode requires. */
export async function authenticateAz(address: string, provider: WalletProvider): Promise<void> {
  const nonce = await azPost<{ message: string; nonce: string }>("/uaapi/user/web3/get-nonce", {
    sourceAddr: address,
    type: "LOGIN",
    chainType: "ETHEREUM",
  });
  const signature = await provider.request({
    method: "personal_sign",
    params: [`${nonce.message}\nnonce: ${nonce.nonce}.`, address],
  });
  if (typeof signature !== "string")
    throw new ApiError("AZ_WALLET_SIGNATURE_INVALID", "Invalid wallet signature", 400);
  const login = await azPost<{ accessToken: string }>("/uaapi/user/web3/login", {
    signature,
    sourceAddr: address,
    chainType: "ETHEREUM",
    chainId: 1,
    loginType: "WALLET",
  });
  setAzToken(login.accessToken);
}

/** An expired AZ token is dropped so the page asks for a new AZ login instead of looping. */
async function withAz<T>(call: Promise<T>): Promise<T> {
  const token = azToken;
  try {
    return await call;
  } catch (cause) {
    if (token && token === azToken && cause instanceof ApiError && cause.status === 401)
      setAzToken(null);
    throw cause;
  }
}

function requestAz<T>(path: string, init?: RequestInit, readOnlyRequest = false): Promise<T> {
  return withAz(
    send<T>(
      apiBaseUrl,
      "MEME",
      path,
      { ...init, headers: { ...azAuthorization(), ...init?.headers } },
      false,
      readOnlyRequest,
    ),
  );
}

export type LedgerCurrency = "USDC" | "USDG" | "USDT";
export type PeerAccountType = "SPOT" | "FUTURES_U";
export interface MemeBalance {
  currency: LedgerCurrency;
  total: string;
  available: string;
  frozen: string;
  tradeFrozen: string;
  withdrawFrozen: string;
}
export interface MemeQuota {
  enabled: boolean;
  limitUsd: string;
  remainingBuyUsd: string;
  netBoughtUsd: string;
  inFlightBuyUsd: string;
}
export interface MemeTransfer {
  transferId: string;
  requestId: string;
  direction: "DEPOSIT" | "WITHDRAW";
  peerAccountType: PeerAccountType;
  currency: LedgerCurrency;
  amount: string;
  status: string;
  failureCode: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}
export interface MemeBill {
  billId: string;
  currency: LedgerCurrency;
  billType: string;
  side: 1 | 2;
  amount: string;
  beforeBalance: string;
  afterBalance: string;
  refType: string;
  refId: string;
  remark: string | null;
  createdAt: number;
}

/** meme-account user API: every call is a POST carrying the AZ login. */
function accountPost<T>(path: string, body: unknown, readOnlyRequest: boolean): Promise<T> {
  return withAz(
    send<T>(
      accountBaseUrl,
      "MEME",
      `/sapi/v1/meme-account${path}`,
      { method: "POST", body: JSON.stringify(body), headers: azAuthorization() },
      false,
      readOnlyRequest,
    ),
  );
}

export const memeAccountApi = {
  balances: () =>
    accountPost<{ userId: string; balances: MemeBalance[]; quota: MemeQuota }>(
      "/balances",
      {},
      true,
    ),
  deposit: (input: {
    requestId: string;
    sourceAccountType: PeerAccountType;
    currency: LedgerCurrency;
    amount: string;
  }) => accountPost<MemeTransfer>("/transfers/deposit", input, false),
  withdraw: (input: {
    requestId: string;
    targetAccountType: PeerAccountType;
    currency: LedgerCurrency;
    amount: string;
  }) => accountPost<MemeTransfer>("/transfers/withdraw", input, false),
  transfers: (limit = 20) =>
    accountPost<{ items: MemeTransfer[]; nextCursor: string | null }>(
      "/transfers/list",
      { limit },
      true,
    ),
  bills: (limit = 20) =>
    accountPost<{ items: MemeBill[]; nextCursor: string | null }>("/bills/list", { limit }, true),
};

export const memeApi = {
  getConfig: () =>
    requestPublicMarket<{
      chainId: number;
      chainName: string;
      explorerBaseUrl: string;
      defaultSlippageBps: number;
      marketRefreshMs: { hot: number; new: number };
      accountMode: "AZ_ACCOUNT" | "TREASURY_OPERATORS";
      tradingEnabled?: boolean;
      minBuyAmountUsd?: string;
      mainAccountAddress: string | null;
      settlementAssets: Asset[];
    }>("/sapi/v1/meme/config"),
  getMarkets: (tab: "hot" | "new" = "hot") =>
    requestPublicMarket<{ items: Token[]; stale: boolean }>(
      `/sapi/v1/meme/markets?tab=${tab}&limit=50`,
    ),
  searchMarkets: (query: string) =>
    requestPublicMarket<{ items: Token[]; stale: boolean }>(
      `/sapi/v1/meme/markets?query=${encodeURIComponent(query)}&limit=50`,
    ),
  getToken: (tokenAddress: string, retry = false) =>
    requestPublicMarket<Token>(`/sapi/v1/meme/tokens/${tokenAddress}${retry ? "?retry=1" : ""}`),
  getCandles: (
    tokenAddress: string,
    interval: Interval,
    options?: {
      from?: number;
      to?: number;
      limit?: number;
      series?: Candle["series"];
      signal?: AbortSignal;
    },
  ) => {
    const query = new URLSearchParams({ interval, limit: String(options?.limit ?? 300) });
    if (options?.from !== undefined) query.set("from", String(options.from));
    if (options?.to !== undefined) query.set("to", String(options.to));
    if (options?.series !== undefined) query.set("series", options.series);
    return requestPublicMarket<CandleSnapshot>(
      `/sapi/v1/meme/tokens/${tokenAddress}/candles?${query.toString()}`,
      { signal: options?.signal },
    );
  },
  getTrades: (tokenAddress: string, cursor?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    return requestPublicMarket<{ items: Trade[]; nextCursor: string | null }>(
      `/sapi/v1/meme/tokens/${tokenAddress}/trades?${query.toString()}`,
      { signal },
    );
  },
  getAccount: (signal?: AbortSignal) =>
    requestAz<AccountSummary>("/sapi/v1/meme/account/summary", { signal }),
  getAccountTransactions: (signal?: AbortSignal) =>
    requestAz<{ items: AccountTransaction[] }>("/sapi/v1/meme/account/transactions?limit=50", {
      signal,
    }),
  getAccountTransaction: (executionId: string) =>
    requestAz<AccountTransaction>(`/sapi/v1/meme/account/transactions/${executionId}`),
  executeMainAccountTrade: (input: AccountTradeInput) => executeAccountTrade(input),
  createQuote: (input: QuoteRequest, signal?: AbortSignal) => {
    const { feeConfigVersion: _boundFeeVersion, ...body } = input;
    return requestAz<QuoteDisplay>(
      "/sapi/v1/meme/quotes",
      {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      },
      input.purpose === "ESTIMATE",
    ).then((value): ValidQuote => requireQuoteTerms(value, input));
  },
  getWsTicket: (signal?: AbortSignal, publicMarket = false) =>
    (publicMarket ? requestPublicMarket : request)<{ ticket: string; expiresAt: number }>(
      "/sapi/v1/meme/ws-ticket",
      { method: "POST", signal },
    ),
};

export const wsBaseUrl = resolveWsBaseUrl(
  import.meta.env.VITE_MEME_WS_URL as string | undefined,
  window.location,
);

export interface AccountTradeInput {
  walletAddress: string;
  clientExecutionId: string;
  side: "BUY" | "SELL";
  tokenAddress: string;
  settlementAsset: Asset;
  quoteId: string;
  routeFingerprint?: string;
  minAmountOut: string;
  amountIn: string;
  slippageBps: number;
  feeConfigVersion: string;
  /** Ledger currency a BUY spends; the treasury itself always pays USDG on chain. */
  spendCurrency?: LedgerCurrency;
}

const tradeRejectionMessages: Record<string, string> = {
  MEME_OPERATOR_BUSY: "Trading is busy right now. Try again in a few seconds",
  MEME_EXECUTION_IN_PROGRESS: "Your previous trade is still processing. Wait for it to finish",
  MEME_POSITION_INSUFFICIENT: "Sell amount exceeds your available balance",
  MEME_TREASURY_APPROVAL_PENDING: "This token is being enabled for selling. Try again in a minute",
  MEME_TREASURY_APPROVAL_REQUIRED: "Buying is temporarily unavailable. Try again later",
};

async function executeAccountTrade(input: AccountTradeInput): Promise<AccountTransaction> {
  const executionSession = sessionToken;
  const pendingId = pendingExecutionId(input.walletAddress);
  if (pendingId) {
    const existing = await memeApi.getAccountTransaction(pendingId);
    if (sessionToken !== executionSession)
      throw new Error("Wallet changed. Return to the original wallet to view trade status");
    if (existing.status !== "CONFIRMED" && existing.status !== "FAILED") return existing;
    forgetExecution(input.walletAddress, pendingId);
  }
  const { walletAddress, feeConfigVersion: _boundFeeVersion, ...body } = input;
  // Save before POST: the request can time out after the server has created the record.
  rememberExecution(walletAddress, input.clientExecutionId);
  try {
    const result = await requestAz<AccountTransaction>("/sapi/v1/meme/account/transactions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    rememberExecution(walletAddress, result.executionId);
    if (result.status === "CONFIRMED" || result.status === "FAILED")
      forgetExecution(walletAddress, result.executionId);
    return result;
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      ((typeof cause.details === "object" &&
        cause.details !== null &&
        "executionStage" in cause.details &&
        cause.details.executionStage === "NOT_CREATED") ||
        [
          "MEME_ROUTE_STALE",
          "MEME_FEE_CONFIG_CHANGED",
          "MEME_QUOTE_REQUEST_MISMATCH",
          "MEME_UNAUTHORIZED",
          "MEME_ATOMIC_BALANCE_INSUFFICIENT",
          "MEME_ATOMIC_SIMULATION_FAILED",
          "MEME_MAIN_ACCOUNT_EXECUTION_DISABLED",
          // The order entry throws these only before it stores the trade record.
          "MEME_TRADING_DISABLED",
          "MEME_QUOTE_EXPIRED",
          "MEME_HONEYPOT",
          "MEME_ATOMIC_PLAN_CHANGED",
          ...Object.keys(tradeRejectionMessages),
        ].includes(cause.code))
    ) {
      // Only a known pre-create rejection retires this attempt. Once a record exists,
      // even an authentication error must leave its ID available for receipt recovery.
      forgetExecution(walletAddress, input.clientExecutionId);
    }
    if (cause instanceof ApiError && cause.code in tradeRejectionMessages)
      throw new ApiError(
        cause.code,
        tradeRejectionMessages[cause.code]!,
        cause.status,
        cause.details,
      );
    throw cause;
  }
}
