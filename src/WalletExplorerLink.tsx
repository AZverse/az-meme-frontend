import type { ReactNode } from "react";

/** This explorer serves Robinhood chain 4663 only. */
export function WalletExplorerLink({
  chainId,
  kind,
  value,
  children,
}: {
  chainId: number | undefined;
  kind: "tx" | "address";
  value: string;
  children: ReactNode;
}) {
  const valid = kind === "tx" ? /^0x[0-9a-f]{64}$/i : /^0x[0-9a-f]{40}$/i;
  if (chainId !== 4663 || !valid.test(value)) return kind === "tx" ? <>{children}</> : null;
  return (
    <a
      className="wallet-explorer-link"
      href={`https://robinhoodchain.blockscout.com/${kind}/${value}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View ${kind === "tx" ? "transaction" : "wallet address"} ${value} on Blockscout`}
    >
      {children}
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path d="M9 2h5v5M14 2 7 9M7 3H3v10h10V9" />
      </svg>
    </a>
  );
}
