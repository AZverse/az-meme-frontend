import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WalletTrading from "./WalletTrading";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletTrading />
  </StrictMode>,
);
